
import crypto from 'node:crypto';

export const DEFAULT_FOLLOWUP_RULES_PROMPT = `Você faz follow-up pela Delivale quando o cliente parou de responder. Regras: 1) Seja breve (até 3 linhas), educado e natural, sem parecer robô. 2) Não repita saudação nem se apresente de novo. 3) Retome o último assunto da conversa. 4) Tentativa 1: lembre de forma leve e pergunte se ficou alguma dúvida. Tentativa 2: destaque um benefício relevante ao que o cliente perguntou (ex.: cardápio digital, valor fixo sem taxas extras, impressão automática, QR Code na mesa) e ofereça um teste. Tentativa 3: despedida cordial, avisando que ficamos à disposição. 5) Nunca invente preços ou condições; use apenas o que está cadastrado. 6) Se o cliente já recusou ou pediu para parar, não envie. 7) Use no máximo um emoji. 8) Termine com uma pergunta simples.`;

export const DEFAULT_FOLLOWUP_CONFIG = {
  enabled: false,
  maxAttempts: 3,
  attempts: [
    { attempt: 1, interval: 30, unit: 'minutes' },
    { attempt: 2, interval: 4, unit: 'hours' },
    { attempt: 3, interval: 24, unit: 'hours' }
  ],
  windowStart: '08:00',
  windowEnd: '20:00',
  timeZone: 'America/Sao_Paulo',
  stopOnOptout: true,
  rulesPrompt: DEFAULT_FOLLOWUP_RULES_PROMPT
};

export function getInstanceFollowupConfig(db, instanceName) {
  if (!instanceName) return structuredClone(DEFAULT_FOLLOWUP_CONFIG);
  try {
    const row = db.prepare('SELECT config_json FROM instance_followup_configs WHERE instance_name = ?').get(instanceName);
    if (row && row.config_json) {
      const parsed = JSON.parse(row.config_json);
      return {
        ...DEFAULT_FOLLOWUP_CONFIG,
        ...parsed,
        rulesPrompt: parsed.rulesPrompt !== undefined ? parsed.rulesPrompt : DEFAULT_FOLLOWUP_RULES_PROMPT
      };
    }
  } catch (err) {
    console.warn('[AI Follow-up] Erro ao ler config da instância:', err.message);
  }
  return structuredClone(DEFAULT_FOLLOWUP_CONFIG);
}

export function saveInstanceFollowupConfig(db, instanceName, config) {
  if (!instanceName) throw new Error('Nome da instância obrigatório');
  const merged = {
    ...DEFAULT_FOLLOWUP_CONFIG,
    ...config,
    updatedAt: new Date().toISOString()
  };
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO instance_followup_configs (instance_name, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(instance_name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `).run(instanceName, JSON.stringify(merged), nowIso);
  return merged;
}

export function detectClientOptOut(text) {
  if (!text) return false;
  const norm = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[!?.…~*_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const optOutPhrases = [
    'nao tenho interesse', 'nao quero', 'sem interesse',
    'nao tenho mais interesse', 'pare de me mandar',
    'pare de mandar', 'pare', 'parar', 'sair', 'stop',
    'descadastrar', 'remover meu numero', 'nao me mande mais',
    'nao entre em contato', 'nao perturbe', 'bloquear',
    'nao precisa mais', 'nao quero mais', 'desinscrever'
  ];
  return optOutPhrases.some(phrase => norm === phrase || norm.includes(phrase));
}

export function getSaoPauloDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10)
  };
}

export function saoPauloTimeToDate(year, month, day, hour, minute) {
  let d = new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0));
  const sp = getSaoPauloDate(d);
  const diffHours = hour - sp.hour;
  if (diffHours !== 0) {
    d = new Date(d.getTime() + diffHours * 3600000);
  }
  return d;
}

export function isWithinAllowedWindow(date = new Date(), windowStart = '08:00', windowEnd = '20:00') {
  const sp = getSaoPauloDate(date);
  const currentMinutes = sp.hour * 60 + sp.minute;
  const [sH, sM] = (windowStart || '08:00').split(':').map(Number);
  const [eH, eM] = (windowEnd || '20:00').split(':').map(Number);
  const startMin = (sH || 8) * 60 + (sM || 0);
  const endMin = (eH || 20) * 60 + (eM || 0);
  return currentMinutes >= startMin && currentMinutes < endMin;
}

export function calculateNextAllowedDate(scheduledDate = new Date(), windowStart = '08:00', windowEnd = '20:00') {
  const sp = getSaoPauloDate(scheduledDate);
  const currentMinutes = sp.hour * 60 + sp.minute;
  const [sH, sM] = (windowStart || '08:00').split(':').map(Number);
  const [eH, eM] = (windowEnd || '20:00').split(':').map(Number);
  const startMin = (sH || 8) * 60 + (sM || 0);
  const endMin = (eH || 20) * 60 + (eM || 0);

  if (currentMinutes >= startMin && currentMinutes < endMin) {
    return scheduledDate;
  }

  let targetYear = sp.year;
  let targetMonth = sp.month;
  let targetDay = sp.day;

  if (currentMinutes >= endMin) {
    const temp = new Date(Date.UTC(sp.year, sp.month - 1, sp.day + 1));
    targetYear = temp.getUTCFullYear();
    targetMonth = temp.getUTCMonth() + 1;
    targetDay = temp.getUTCDate();
  }

  return saoPauloTimeToDate(targetYear, targetMonth, targetDay, sH || 8, sM || 0);
}

export function cancelPendingFollowups(db, instance, remoteJid, reason = 'cancelled') {
  try {
    const nowIso = new Date().toISOString();
    const res = db.prepare(`
      UPDATE followups
      SET status = 'cancelled', cancel_reason = ?, updated_at = ?
      WHERE instance = ? AND remote_jid = ? AND status = 'scheduled'
    `).run(reason, nowIso, instance, remoteJid);
    if (res.changes > 0) {
      console.log(`[AI Follow-up] 🚫 ${res.changes} follow-up(s) cancelado(s) para ${remoteJid} (${instance}): motivo "${reason}".`);
    }
    return res.changes;
  } catch (err) {
    console.error('[AI Follow-up Cancel Error]', err);
    return 0;
  }
}

export function markConversationCycleStatus(db, instance, remoteJid, status = 'active') {
  try {
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE conversation_cycles
      SET status = ?, updated_at = ?
      WHERE instance = ? AND remote_jid = ?
    `).run(status, nowIso, instance, remoteJid);
  } catch {}
}

export function getOrCreateCurrentCycleId(db, instance, remoteJid, phone) {
  try {
    const row = db.prepare('SELECT cycle_id, status FROM conversation_cycles WHERE instance = ? AND remote_jid = ?').get(instance, remoteJid);
    if (row && row.cycle_id) {
      return row.cycle_id;
    }
    const newCycleId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversation_cycles (instance, remote_jid, cycle_id, status, updated_at)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(instance, remote_jid) DO UPDATE SET cycle_id = excluded.cycle_id, status = 'active', updated_at = excluded.updated_at
    `).run(instance, remoteJid, newCycleId, nowIso);
    return newCycleId;
  } catch (err) {
    console.error('[AI Follow-up Cycle Error]', err);
    return crypto.randomUUID();
  }
}

export function rotateConversationCycle(db, instance, remoteJid, phone) {
  try {
    const newCycleId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversation_cycles (instance, remote_jid, cycle_id, last_user_message_at, status, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?)
      ON CONFLICT(instance, remote_jid) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        last_user_message_at = excluded.last_user_message_at,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(instance, remoteJid, newCycleId, nowIso, nowIso);
    return newCycleId;
  } catch (err) {
    console.error('[AI Follow-up Cycle Rotate Error]', err);
    return crypto.randomUUID();
  }
}

export function scheduleNextFollowup(db, instanceName, remoteJid, phoneDigits, attemptNumber, cycleId) {
  try {
    if (!instanceName || !remoteJid || !phoneDigits || !cycleId) return null;
    if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) return null;

    const inst = db.prepare('SELECT * FROM instances WHERE name = ?').get(instanceName);
    if (!inst || inst.role === 'DISPARO') return null;

    const config = getInstanceFollowupConfig(db, instanceName);
    if (!config || !config.enabled) return null;

    const maxAttempts = Number(config.maxAttempts) || 3;
    if (attemptNumber > maxAttempts) {
      db.prepare("UPDATE conversation_cycles SET status = 'no_response', updated_at = ? WHERE instance = ? AND remote_jid = ?")
        .run(new Date().toISOString(), instanceName, remoteJid);
      console.log(`[AI Follow-up] Limite de ${maxAttempts} tentativas atingido para ${phoneDigits}.`);
      return null;
    }

    const attemptCfg = (config.attempts || []).find(a => Number(a.attempt) === Number(attemptNumber)) ||
                       config.attempts?.[attemptNumber - 1] ||
                       { interval: attemptNumber === 1 ? 30 : (attemptNumber === 2 ? 4 : 24), unit: attemptNumber === 1 ? 'minutes' : 'hours' };

    let intervalMs = 30 * 60 * 1000;
    const intervalVal = Math.max(1, Number(attemptCfg.interval) || 30);
    if (attemptCfg.unit === 'hours') {
      intervalMs = intervalVal * 60 * 60 * 1000;
    } else if (attemptCfg.unit === 'days') {
      intervalMs = intervalVal * 24 * 60 * 60 * 1000;
    } else {
      intervalMs = intervalVal * 60 * 1000;
    }

    const targetDate = new Date(Date.now() + intervalMs);
    const scheduledDate = calculateNextAllowedDate(targetDate, config.windowStart || '08:00', config.windowEnd || '20:00');
    const scheduledIso = scheduledDate.toISOString();
    const nowIso = new Date().toISOString();
    const id = crypto.randomUUID();

    const res = db.prepare(`
      INSERT OR IGNORE INTO followups (
        id, instance, remote_jid, phone, attempt_number, cycle_id, scheduled_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
    `).run(id, instanceName, remoteJid, phoneDigits, attemptNumber, cycleId, scheduledIso, nowIso, nowIso);

    if (res.changes) {
      console.log(`[AI Follow-up] ⏰ Tentativa ${attemptNumber}/${maxAttempts} agendada para ${phoneDigits} (${instanceName}) em ${scheduledIso}`);
      return id;
    }
  } catch (err) {
    console.error('[AI Follow-up Schedule Error]', err);
  }
  return null;
}

export async function generateFollowupWithGemini({
  apiKey,
  instanceName,
  phone,
  companyName,
  attemptNumber,
  maxAttempts,
  timeElapsedText,
  rulesPrompt,
  offer,
  historyRows = [],
  preferredModel = 'gemini-2.5-flash'
}) {
  if (!apiKey) {
    return { ok: false, error: 'Chave Gemini não configurada' };
  }

  const formattedContents = [];
  for (const h of historyRows) {
    const role = h.role === 'model' ? 'model' : 'user';
    if (formattedContents.length && formattedContents[formattedContents.length - 1].role === role) {
      formattedContents[formattedContents.length - 1].parts[0].text += '\n' + h.content;
    } else {
      formattedContents.push({ role, parts: [{ text: h.content }] });
    }
  }
  if (formattedContents.length === 0) {
    formattedContents.push({ role: 'user', parts: [{ text: 'Olá' }] });
  }

  const systemInstruction = `VOCÊ É O ASSISTENTE DE VENDAS E ATENDIMENTO DA DELIVALE NO WHATSAPP REALIZANDO UM FOLLOW-UP AUTOMÁTICO.
O cliente parou de responder a conversa anterior.

REGRAS DE FOLLOW-UP CONFIGURADAS PELO GESTOR (SIGA ESTRITAMENTE):
${rulesPrompt}

DADOS DA TENTATIVA ATUAL:
- Número da tentativa: ${attemptNumber} de ${maxAttempts}.
- Tempo decorrido sem resposta: ${timeElapsedText}.
- Nome do contato/estabelecimento: ${companyName}.
- Oferta comercial cadastrada: ${offer}

DIRETRIZES MANDATÓRIAS E REGRAS ANTI-ALUCINAÇÃO:
1. NÃO cumprimente novamente nem se reapresente (é estritamente proibido dizer "Olá", "Bom dia", "Tudo bem?", "Aqui é da Delivale").
2. Retome o último assunto da conversa onde ela parou.
3. Abordagem de acordo com a tentativa ${attemptNumber}:
   - Tentativa 1: lembrete leve, perguntando se ficou alguma dúvida.
   - Tentativa 2: destaque um benefício objetivo relevante e ofereça um teste gratuito.
   - Tentativa 3 (última): despedida cordial avisando que ficamos à disposição.
4. Mensagem curta (no MÁXIMO 3 linhas), humana e sem pressão. No máximo 1 emoji.
5. Termine com uma pergunta simples ou próximo passo claro.
6. NUNCA invente preços, prazos ou promoções além do cadastrado.
7. Responda APENAS o texto da mensagem de WhatsApp, sem aspas, títulos ou notas.`;

  const modelsToTry = [preferredModel, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite']
    .filter((m, i, arr) => m && arr.indexOf(m) === i);

  let replyText = '';
  let lastErr = null;

  for (const m of modelsToTry) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: formattedContents,
          generationConfig: {
            temperature: 0.25,
            maxOutputTokens: 180
          }
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (resp.ok) {
        const data = await resp.json();
        replyText = (data.candidates?.[0]?.content?.parts || [])
          .filter(p => !p.thought && typeof p.text === 'string')
          .map(p => p.text)
          .join('\n')
          .trim();
        if (replyText) break;
      } else {
        lastErr = new Error(`HTTP ${resp.status}`);
        if (resp.status === 401 || resp.status === 403) break;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (replyText) {
    return { ok: true, text: replyText };
  }
  return { ok: false, error: lastErr?.message || 'Falha ao gerar resposta com Gemini' };
}

let isFollowupRunning = false;
let lastCrashCheckAt = 0;

export async function processFollowupTick(db, env, decryptSecret, recordBotSent, isAiPausedForContact) {
  if (isFollowupRunning) return;
  isFollowupRunning = true;

  try {
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();

    if (nowMs - lastCrashCheckAt > 60000) {
      lastCrashCheckAt = nowMs;
      try {
        db.prepare(`
          UPDATE followups
          SET status = 'uncertain', cancel_reason = 'recovered_after_crash', updated_at = ?
          WHERE status = 'processing' AND (strftime('%s', ?) - strftime('%s', updated_at)) > 300
        `).run(nowIso, nowIso);
      } catch (err) {
        console.warn('[AI Follow-up] Erro na recuperação periódica:', err.message);
      }
    }

    const candidates = db.prepare(`
      SELECT * FROM followups
      WHERE status = 'scheduled' AND datetime(scheduled_at) <= datetime(?)
      ORDER BY scheduled_at ASC
      LIMIT 2
    `).all(nowIso);

    for (const item of candidates) {
      const claimResult = db.prepare(`
        UPDATE followups
        SET status = 'processing', updated_at = ?
        WHERE id = ? AND status = 'scheduled'
      `).run(nowIso, item.id);

      if (!claimResult.changes) {
        continue;
      }

      console.log(`[AI Follow-up] 🔍 Revalidando follow-up tentativa ${item.attempt_number} para ${item.phone} (${item.instance})...`);

      const sRow = db.prepare('SELECT config_json, key_cipher FROM settings WHERE id = 1').get();
      const globalCfg = sRow ? JSON.parse(sRow.config_json || '{}') : {};
      if (globalCfg.aiEnabled === false) {
        console.log(`[AI Follow-up] ⏸️ IA desligada globalmente. Cancelando follow-up de ${item.phone}.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = 'ai_disabled_globally', updated_at = ? WHERE id = ?")
          .run(nowIso, item.id);
        continue;
      }

      const instCfg = getInstanceFollowupConfig(db, item.instance);
      if (!instCfg.enabled) {
        console.log(`[AI Follow-up] ⏸️ Follow-up desligado na instância ${item.instance}. Cancelando.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = 'followup_disabled_for_instance', updated_at = ? WHERE id = ?")
          .run(nowIso, item.id);
        continue;
      }

      const inst = db.prepare('SELECT * FROM instances WHERE name = ?').get(item.instance);
      if (!inst || inst.role === 'DISPARO') {
        console.warn(`[AI Follow-up] ⚠️ Instância ${item.instance} inválida ou papel DISPARO. Cancelando.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = 'instance_invalid_or_disparo', updated_at = ? WHERE id = ?")
          .run(nowIso, item.id);
        continue;
      }

      const activePause = isAiPausedForContact(db, item.phone);
      if (activePause && globalCfg.aiHumanDetection !== false) {
        console.log(`[AI Follow-up] 👤 Contato ${item.phone} em pausa por humano até ${activePause.paused_until}. Cancelando.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = 'human_intervention', updated_at = ? WHERE id = ?")
          .run(nowIso, item.id);
        continue;
      }

      const cycle = db.prepare('SELECT * FROM conversation_cycles WHERE instance = ? AND remote_jid = ?').get(item.instance, item.remote_jid);
      if (!cycle || cycle.cycle_id !== item.cycle_id || cycle.status !== 'active') {
        const reason = (cycle?.status === 'opt_out') ? 'client_opt_out' : 'cycle_invalid_or_replied';
        console.log(`[AI Follow-up] Ciclo inválido ou finalizado (${reason}) para ${item.phone}. Cancelando.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?")
          .run(reason, nowIso, item.id);
        continue;
      }

      const newClientMsg = db.prepare("SELECT COUNT(*) as n FROM chat_messages WHERE phone = ? AND role = 'user' AND created_at > ?")
        .get(item.phone, item.created_at);
      if (newClientMsg?.n > 0) {
        console.log(`[AI Follow-up] Cliente ${item.phone} respondeu após o agendamento. Cancelando.`);
        db.prepare("UPDATE followups SET status = 'cancelled', cancel_reason = 'client_replied', updated_at = ? WHERE id = ?")
          .run(nowIso, item.id);
        continue;
      }

      const windowStart = instCfg.windowStart || '08:00';
      const windowEnd = instCfg.windowEnd || '20:00';
      const nowCheck = new Date();
      if (!isWithinAllowedWindow(nowCheck, windowStart, windowEnd)) {
        const nextAllowed = calculateNextAllowedDate(nowCheck, windowStart, windowEnd);
        console.log(`[AI Follow-up] Fora da janela permitida (${windowStart}–${windowEnd}). Reagendando ${item.phone} para ${nextAllowed.toISOString()}`);
        db.prepare("UPDATE followups SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?")
          .run(nextAllowed.toISOString(), nowIso, item.id);
        continue;
      }

      const contact = db.prepare('SELECT * FROM contacts WHERE phone = ? OR phone = ?').get(item.phone, '55' + item.phone);
      const companyName = contact?.company || 'Cliente';
      const historyRows = db.prepare("SELECT role, content, created_at FROM chat_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 8")
        .all(item.phone).reverse();

      const lastMsg = historyRows[historyRows.length - 1];
      let timeElapsedText = 'algum tempo';
      if (lastMsg?.created_at) {
        const diffMs = Date.now() - new Date(lastMsg.created_at).getTime();
        const diffHours = Math.round(diffMs / (3600 * 1000));
        if (diffHours < 1) {
          const diffMins = Math.max(1, Math.round(diffMs / (60 * 1000)));
          timeElapsedText = `${diffMins} minutos`;
        } else if (diffHours < 24) {
          timeElapsedText = `${diffHours} hora(s)`;
        } else {
          timeElapsedText = `${Math.round(diffHours / 24)} dia(s)`;
        }
      }

      let apiKey = env.GEMINI_API_KEY || '';
      if (sRow?.key_cipher) {
        try { apiKey = await decryptSecret(sRow.key_cipher, env); } catch {}
      }

      const generated = await generateFollowupWithGemini({
        apiKey,
        instanceName: item.instance,
        phone: item.phone,
        companyName,
        attemptNumber: item.attempt_number,
        maxAttempts: instCfg.maxAttempts || 3,
        timeElapsedText,
        rulesPrompt: instCfg.rulesPrompt || DEFAULT_FOLLOWUP_RULES_PROMPT,
        offer: globalCfg.offer || 'Cardápio digital próprio para delivery com 30 dias grátis de teste.',
        historyRows,
        preferredModel: globalCfg.aiModel || env.GEMINI_MODEL || 'gemini-2.5-flash'
      });

      if (!generated.ok || !generated.text) {
        console.error(`[AI Follow-up] ❌ Falha da IA para ${item.phone}:`, generated.error);
        db.prepare("UPDATE followups SET status = 'failed', error_details = ?, updated_at = ? WHERE id = ?")
          .run(String(generated.error || 'gemini_error').slice(0, 500), nowIso, item.id);
        continue;
      }

      const followupText = generated.text.trim();

      const tokenCipher = inst.token_cipher || inst.instance_token_cipher;
      const token = await decryptSecret(tokenCipher, env);
      const baseUrl = String(inst.api_url || '').replace(/\/$/, '');

      recordBotSent(item.phone);

      let sendEndpoint = '';
      let sendBody = {};
      if (inst.provider === 'EVOLUTION_GO') {
        sendEndpoint = `${baseUrl}/message/sendText`;
        sendBody = { number: item.phone, text: followupText };
      } else {
        sendEndpoint = `${baseUrl}/message/sendText/${encodeURIComponent(inst.name)}`;
        sendBody = { number: item.phone, text: followupText, textMessage: { text: followupText } };
      }

      let sendResp = null;
      let sendErr = null;
      try {
        sendResp = await fetch(sendEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': token },
          body: JSON.stringify(sendBody),
          signal: AbortSignal.timeout(25000)
        });
      } catch (err) {
        sendErr = err;
      }

      if (sendErr || !sendResp) {
        console.error(`[AI Follow-up] ⚠️ Envio incerto para ${item.phone}:`, sendErr?.message);
        db.prepare("UPDATE followups SET status = 'uncertain', error_details = ?, updated_at = ? WHERE id = ?")
          .run(String(sendErr?.message || 'timeout').slice(0, 500), nowIso, item.id);
        continue;
      }

      if (!sendResp.ok) {
        let errJson = null;
        try { errJson = await sendResp.json(); } catch {}
        console.error(`[AI Follow-up] Evolution recusou envio (HTTP ${sendResp.status}) para ${item.phone}:`, errJson);
        db.prepare("UPDATE followups SET status = 'failed', error_details = ?, updated_at = ? WHERE id = ?")
          .run(`http_${sendResp.status}: ${JSON.stringify(errJson || {}).slice(0, 300)}`, nowIso, item.id);
        continue;
      }

      let respData = {};
      try { respData = await sendResp.json(); } catch {}
      const sentMsgId = respData?.key?.id || respData?.messageId || crypto.randomUUID();
      const sentTimeIso = new Date().toISOString();

      db.prepare(`
        UPDATE followups
        SET status = 'sent', sent_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(sentMsgId, sentTimeIso, item.id);

      try {
        db.prepare("INSERT INTO chat_messages (id, phone, role, content, created_at) VALUES (?, ?, 'model', ?, ?)")
          .run(crypto.randomUUID(), item.phone, followupText, sentTimeIso);
      } catch {}

      try {
        db.prepare("INSERT INTO sends (id, company, phone, message, type, opened_at, status, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)")
          .run(crypto.randomUUID(), companyName, item.phone, followupText, `Follow-up IA (Tentativa ${item.attempt_number})`, sentTimeIso, sentTimeIso);
      } catch {}

      if (contact) {
        try {
          db.prepare("INSERT INTO contact_events (id, contact_id, event, details, created_at) VALUES (?, ?, 'AI_FOLLOWUP_SENT', ?, ?)")
            .run(crypto.randomUUID(), contact.id, `Follow-up IA tentativa ${item.attempt_number} enviado (${item.instance}): "${followupText.slice(0, 80)}..."`, sentTimeIso);
        } catch {}
      }

      db.prepare("UPDATE conversation_cycles SET last_ai_message_at = ?, updated_at = ? WHERE instance = ? AND remote_jid = ?")
        .run(sentTimeIso, nowIso, item.instance, item.remote_jid);
    }
  } catch (err) {
    console.error('[AI Follow-up Tick Error]', err);
  } finally {
    isFollowupRunning = false;
  }
}
