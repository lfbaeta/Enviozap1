function parseSpintax(text) {
  let prev;
  do {
    prev = text;
    text = text.replace(/\{([^{}]+)\}/g, (m, c) => c.includes('|') ? c.split('|')[Math.floor(Math.random() * c.split('|').length)] : m);
  } while (text !== prev);
  return text;
}

export async function decryptSecret(cipher, env) {
  if (!cipher) return '';
  const [iv, data] = cipher.split('.');
  if (!iv || !data) return '';
  const keyHex = env.SETTINGS_ENCRYPTION_KEY || '01'.repeat(32);
  const keyBuf = Uint8Array.from(keyHex.match(/.{2}/g).map(v => parseInt(v, 16)));
  const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, ['decrypt']);
  const ivBuf = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
  const dataBuf = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, dataBuf);
  return new TextDecoder().decode(dec);
}

let isTicking = false;

export async function processQueueTick(db, env) {
  if (isTicking) return;
  isTicking = true;

  try {
    const rules = db.prepare('SELECT * FROM send_rules WHERE id = 1').get();
    if (!rules || rules.queue_state !== 'RUNNING') return;

    // Se houver tempo de espera programado e ainda não expirou, aguarda
    if (rules.next_send_at) {
      const nextTime = new Date(rules.next_send_at).getTime();
      if (Date.now() < nextTime) return;
    }

    // Busca o próximo item pendente na fila
    const item = db.prepare(`
      SELECT q.id, q.contact_id, q.message, q.position,
             c.company, c.phone, c.city, c.responsible
      FROM send_queue q
      JOIN contacts c ON c.id = q.contact_id
      WHERE q.status = 'QUEUED'
      ORDER BY q.position ASC, q.created_at ASC
      LIMIT 1
    `).get();

    if (!item) {
      // Fila concluída!
      db.prepare(`
        UPDATE send_rules
        SET queue_state = 'PAUSED', next_send_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = 1
      `).run(new Date().toISOString());
      console.log('[QueueRunner] Todos os contatos da fila foram processados.');
      return;
    }

    // Busca configurações para regras de disparo e instância dedicada
    const settingsRow = db.prepare('SELECT config_json FROM settings WHERE id = 1').get();
    let cfg = {};
    try { if (settingsRow?.config_json) cfg = JSON.parse(settingsRow.config_json); } catch {}

    // Busca instâncias conectadas respeitando a separação entre Disparo e IA
    let instances = [];
    if (cfg.disparoInstanceId && cfg.disparoInstanceId !== 'ALL') {
      instances = db.prepare(`
        SELECT * FROM instances WHERE id = ? AND status = 'CONNECTED'
      `).all(cfg.disparoInstanceId);
    }
    if (!instances.length) {
      // Prioriza instâncias configuradas para Disparo ou Ambos (ALL), preservando a instância exclusiva da IA
      instances = db.prepare(`
        SELECT * FROM instances WHERE status = 'CONNECTED' AND (role IS NULL OR role = 'ALL' OR role = 'DISPARO')
      `).all();
    }
    if (!instances.length) {
      // Se não houver instância de disparo dedicada, usa qualquer conectada
      instances = db.prepare(`
        SELECT * FROM instances WHERE status = 'CONNECTED'
      `).all();
    }

    if (!instances.length) {
      db.prepare(`
        UPDATE send_rules
        SET queue_state = 'PAUSED', last_error = 'Nenhuma instância WhatsApp conectada para disparos.', updated_at = ?
        WHERE id = 1
      `).run(new Date().toISOString());
      console.warn('[QueueRunner] Nenhuma instância conectada encontrada para disparos.');
      return;
    }

    const now = new Date();
    let selectedInstance = null;
    let earliestRest = null;

    for (const inst of instances) {
      // Verifica período de repouso da instância
      if (inst.rest_until && new Date(inst.rest_until) > now) {
        const restTime = new Date(inst.rest_until).getTime();
        if (!earliestRest || restTime < earliestRest) earliestRest = restTime;
        continue;
      }

      // Verifica limite de mensagens no ciclo
      const cycleLimit = inst.messages_per_cycle || rules.messages_per_cycle || 10;
      if (cycleLimit > 0 && (inst.sent_in_cycle || 0) >= cycleLimit) {
        const restMins = inst.rest_minutes || rules.rest_minutes || 20;
        const restUntil = new Date(Date.now() + restMins * 60 * 1000).toISOString();
        db.prepare('UPDATE instances SET rest_until = ?, sent_in_cycle = 0, updated_at = ? WHERE id = ?')
          .run(restUntil, now.toISOString(), inst.id);
        const restTime = new Date(restUntil).getTime();
        if (!earliestRest || restTime < earliestRest) earliestRest = restTime;
        continue;
      }

      selectedInstance = inst;
      break;
    }

    if (!selectedInstance) {
      if (earliestRest) {
        db.prepare('UPDATE send_rules SET next_send_at = ?, last_error = ?, updated_at = ? WHERE id = 1')
          .run(new Date(earliestRest).toISOString(), 'Instâncias em período de repouso programado.', now.toISOString());
      }
      return;
    }

    // Marca item como em processamento
    db.prepare("UPDATE send_queue SET status = 'PROCESSING', instance_name = ?, processing_at = ? WHERE id = ?")
      .run(selectedInstance.name, now.toISOString(), item.id);

    // Determina a mensagem a ser enviada
    let messageText = '';
    let msgType = 'initial';

    if (item.message) {
      try {
        const parsed = JSON.parse(item.message);
        messageText = parsed.text || item.message;
        if (parsed.type) msgType = parsed.type;
      } catch {
        messageText = item.message;
      }
    }

    // Fallback: se a mensagem ainda não foi preparada, prepara agora usando os modelos
    if (!messageText) {
      const settingsRow = db.prepare('SELECT config_json FROM settings WHERE id = 1').get();
      if (settingsRow?.config_json) {
        try {
          const cfg = JSON.parse(settingsRow.config_json);
          messageText = cfg.templates?.[msgType] || cfg.templates?.initial || 'Olá {empresa}!';
        } catch {}
      }
    }

    messageText = String(messageText || '')
      .replaceAll('{empresa}', item.company || 'seu estabelecimento')
      .replaceAll('{telefone}', item.phone || '');
    messageText = parseSpintax(messageText).trim();

    // Normaliza telefone com DDD e DDI 55
    let phoneDigits = String(item.phone || '').replace(/\D/g, '');
    if (!phoneDigits.startsWith('55') && (phoneDigits.length === 10 || phoneDigits.length === 11)) {
      phoneDigits = '55' + phoneDigits;
    }

    // Descriptografa a credencial da instância
    const tokenCipher = selectedInstance.provider === 'EVOLUTION_GO'
      ? (selectedInstance.instance_token_cipher || selectedInstance.token_cipher)
      : selectedInstance.token_cipher;
    const token = await decryptSecret(tokenCipher, env);

    if (!token) {
      throw new Error(`Chave administrativa não encontrada para a instância ${selectedInstance.name}`);
    }

    const baseUrl = String(selectedInstance.api_url || '').replace(/\/$/, '');
    let endpoint = '';
    let bodyData = {};

    if (selectedInstance.provider === 'EVOLUTION_GO') {
      endpoint = `${baseUrl}/message/sendText`;
      bodyData = { number: phoneDigits, text: messageText };
    } else {
      endpoint = `${baseUrl}/message/sendText/${encodeURIComponent(selectedInstance.name)}`;
      bodyData = {
        number: phoneDigits,
        text: messageText
      };
    }

    console.log(`[QueueRunner] Disparando para ${item.company} (${phoneDigits}) via ${selectedInstance.name}...`);

    let sendSuccess = false;
    let sendError = '';

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': token
        },
        body: JSON.stringify(bodyData),
        signal: AbortSignal.timeout(30000)
      });

      let resData = null;
      try { resData = await resp.json(); } catch {}

      if (resp.ok || (resData && (resData.key || resData.messageId || resData.status === 'SUCCESS' || resData.status === 200))) {
        sendSuccess = true;
      } else {
        if (resp.status === 400 && resData?.response?.message?.[0]?.exists === false) {
          sendError = 'Número não possui WhatsApp';
        } else {
          sendError = resData?.message || resData?.error || `HTTP ${resp.status}`;
        }
      }
    } catch (fetchErr) {
      sendError = fetchErr.message || 'Falha de conexão com Evolution API';
    }

    const nowIso = new Date().toISOString();

    if (sendSuccess) {
      console.log(`[QueueRunner] ✅ Mensagem enviada com sucesso para ${item.company}!`);

      // 1. Atualiza o item na fila como ENVIADO e grava a mensagem exata
      db.prepare("UPDATE send_queue SET status = 'SENT', sent_at = ?, message = ?, error = NULL WHERE id = ?")
        .run(nowIso, messageText, item.id);

      // 2. Atualiza o cadastro do contato -> RETIRA DA AGENDA (status = 'SENT')
      db.prepare("UPDATE contacts SET status = 'SENT', last_sent_at = ?, last_instance = ? WHERE id = ?")
        .run(nowIso, selectedInstance.name, item.contact_id);

      // 3. Armazena no Histórico de Enviados com a mensagem exata e dados do cadastro
      const sendId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO sends (id, company, phone, message, type, opened_at, status, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)
      `).run(sendId, item.company, phoneDigits, messageText, msgType, nowIso, nowIso);

      // 4. Registra histórico de eventos do contato
      db.prepare(`
        INSERT INTO contact_events (id, contact_id, event, details, created_at)
        VALUES (?, ?, 'SENT', ?, ?)
      `).run(crypto.randomUUID(), item.contact_id, `Enviado com sucesso via ${selectedInstance.name}`, nowIso);

      // 5. Incrementa contador de envios no ciclo
      const nextCycleCount = (selectedInstance.sent_in_cycle || 0) + 1;
      let restUntil = null;
      let cycleReset = nextCycleCount;

      const cycleLimit = selectedInstance.messages_per_cycle || rules.messages_per_cycle || 10;
      if (cycleLimit > 0 && nextCycleCount >= cycleLimit) {
        const restMins = selectedInstance.rest_minutes || rules.rest_minutes || 20;
        restUntil = new Date(Date.now() + restMins * 60 * 1000).toISOString();
        cycleReset = 0;
        console.log(`[QueueRunner] ☕ Instância ${selectedInstance.name} atingiu ${cycleLimit} envios. Entrando em repouso por ${restMins} minutos.`);
      }

      db.prepare('UPDATE instances SET sent_in_cycle = ?, rest_until = ?, updated_at = ? WHERE id = ?')
        .run(cycleReset, restUntil, nowIso, selectedInstance.id);

      // 6. Sorteia o intervalo para o próximo envio
      const minSec = selectedInstance.min_seconds || rules.min_seconds || 30;
      const maxSec = Math.max(minSec, selectedInstance.max_seconds || rules.max_seconds || 60);
      const delaySeconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
      const nextSendAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

      db.prepare('UPDATE send_rules SET next_send_at = ?, last_error = NULL, updated_at = ? WHERE id = 1')
        .run(nextSendAt, nowIso);
      console.log(`[QueueRunner] Próximo envio programado em ${delaySeconds}s (${nextSendAt})`);
    } else {
      console.error(`[QueueRunner] ❌ Falha no envio para ${item.company}: ${sendError}`);
      db.prepare("UPDATE send_queue SET status = 'ERROR', error = ? WHERE id = ?")
        .run(sendError, item.id);

      db.prepare(`
        INSERT INTO contact_events (id, contact_id, event, details, created_at)
        VALUES (?, ?, 'SEND_FAILED', ?, ?)
      `).run(crypto.randomUUID(), item.contact_id, sendError, nowIso);

      // Pausa curta de 10s antes de tentar o próximo para não travar em caso de erro transitório
      const nextSendAt = new Date(Date.now() + 10000).toISOString();
      db.prepare('UPDATE send_rules SET next_send_at = ?, last_error = ?, updated_at = ? WHERE id = 1')
        .run(nextSendAt, sendError, nowIso);
    }
  } catch (err) {
    console.error('[QueueRunner Error]', err);
    try {
      db.prepare('UPDATE send_rules SET last_error = ?, updated_at = ? WHERE id = 1')
        .run(err.message, new Date().toISOString());
    } catch {}
  } finally {
    isTicking = false;
  }
}
