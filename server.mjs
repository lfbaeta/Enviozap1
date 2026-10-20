import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { processQueueTick, decryptSecret } from './queue-runner.mjs';

const execAsync = promisify(exec);

// 1. Conexão SQLite e Execução de Migrações
const sqlite = new DatabaseSync('./data.db');

function runMigrations(db) {
 const drizzleDir = './drizzle';
 if (!fs.existsSync(drizzleDir)) return;
 const files = fs.readdirSync(drizzleDir).filter(f => f.endsWith('.sql')).sort();
 for (const file of files) {
  const content = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
  const statements = content.split('--> statement-breakpoint');
  for (let stmt of statements) {
   stmt = stmt.trim();
   if (!stmt) continue;
   const safeStmt = stmt.replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ');
   try {
    db.exec(safeStmt);
   } catch {
    // Coluna ou tabela já existente
   }
  }
 }
}

runMigrations(sqlite);

// Garante colunas de regras nas instâncias se não existirem
try {
 sqlite.exec('ALTER TABLE instances ADD COLUMN min_seconds integer DEFAULT 60 NOT NULL;');
} catch {}
try {
 sqlite.exec('ALTER TABLE instances ADD COLUMN max_seconds integer DEFAULT 180 NOT NULL;');
} catch {}
try {
 sqlite.exec('ALTER TABLE instances ADD COLUMN messages_per_cycle integer DEFAULT 10 NOT NULL;');
} catch {}
try {
 sqlite.exec('ALTER TABLE instances ADD COLUMN rest_minutes integer DEFAULT 20 NOT NULL;');
} catch {}
try {
 sqlite.exec("ALTER TABLE instances ADD COLUMN role text DEFAULT 'ALL' NOT NULL;");
} catch {}
try {
 sqlite.exec('ALTER TABLE send_rules ADD COLUMN next_send_at text;');
} catch {}
try {
 sqlite.exec('ALTER TABLE send_rules ADD COLUMN last_error text;');
} catch {}
try {
 sqlite.exec('CREATE TABLE IF NOT EXISTS chat_messages (id text PRIMARY KEY NOT NULL, phone text NOT NULL, role text NOT NULL, content text NOT NULL, created_at text NOT NULL);');
 sqlite.exec('CREATE INDEX IF NOT EXISTS idx_chat_phone_created ON chat_messages(phone, created_at);');
} catch {}
try {
 sqlite.exec('CREATE TABLE IF NOT EXISTS ai_human_interventions (phone text PRIMARY KEY NOT NULL, paused_until text NOT NULL, reason text NOT NULL, detected_at text NOT NULL);');
} catch {}
try {
 sqlite.exec('CREATE TABLE IF NOT EXISTS processed_evolution_messages (id text PRIMARY KEY NOT NULL, processed_at text NOT NULL);');
} catch {}

// 2. Adapter Cloudflare D1 para SQLite local
const DB = {
 prepare(sql) {
  const stmt = sqlite.prepare(sql);
  return {
   bind(...args) {
    return {
     async first() { return stmt.get(...args) || null; },
     async all() { return { results: stmt.all(...args) }; },
     async run() { return { meta: stmt.run(...args) }; }
    };
   }
  };
 }
};

// Carregar variáveis do .env sobrescrevendo placeholders
if (fs.existsSync('./.env')) {
 try {
  const envLines = fs.readFileSync('./.env', 'utf8').split('\n');
  for (const line of envLines) {
   const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
   if (match) {
    const key = match[1];
    let val = (match[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
     val = val.slice(1, -1);
    }
    if (val && (!process.env[key] || process.env[key] === 'MY_GEMINI_API_KEY')) {
     process.env[key] = val;
    }
   }
  }
 } catch {}
}

const localEnv = {
 ...process.env,
 DB,
 SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY || '01'.repeat(32)
};
if (localEnv.GEMINI_API_KEY === 'MY_GEMINI_API_KEY') {
 localEnv.GEMINI_API_KEY = '';
}

// 3. Carregamento dinâmico do Worker (Hot-Reloading)
let currentWorker = null;
let currentCommit = { hash: '', subject: '', date: '', author: '' };
let lastSyncAt = new Date().toISOString();
let isSyncing = false;

async function loadWorker() {
 try {
  const modulePath = './worker/index.js?v=' + Date.now();
  const workerModule = await import(modulePath);
  currentWorker = workerModule.default;
  return true;
 } catch (err) {
  console.error('[Worker] Erro ao carregar worker/index.js:', err);
  return false;
 }
}

// 4. Mecanismo de Sincronização Automática com GitHub (branch main)
const isGitRepo = fs.existsSync(path.join(process.cwd(), '.git'));

async function updateCommitInfo() {
 if (!isGitRepo) return;
 try {
  const { stdout } = await execAsync('git log -1 --pretty=format:"%h|%s|%an|%ad" --date=iso');
  const [hash, subject, author, date] = stdout.trim().split('|');
  currentCommit = { hash, subject, author, date };
 } catch {}
}

let lastSeenRemoteHash = '';

async function syncWithGitHub(force = false) {
 if (!isGitRepo) {
  return { status: 'disabled', message: 'Repositório Git não presente neste ambiente.' };
 }
 if (isSyncing) return { status: 'already_syncing' };
 isSyncing = true;
 lastSyncAt = new Date().toISOString();
 try {
  const { stdout: remotes } = await execAsync('git remote').catch(() => ({ stdout: '' }));
  if (!remotes.split('\n').map(r => r.trim()).includes('origin')) {
   return { status: 'no_remote', message: 'Remoto origin não configurado.' };
  }

  await execAsync('git fetch origin main');
  const { stdout: remoteOut } = await execAsync('git rev-parse origin/main');
  const remoteHash = remoteOut.trim();

  if (!lastSeenRemoteHash) {
   lastSeenRemoteHash = remoteHash;
  }

  const { stdout: countOut } = await execAsync('git rev-list HEAD..origin/main --count');
  const newCommitsCount = Number(countOut.trim()) || 0;

  if (newCommitsCount > 0 || (force && remoteHash !== lastSeenRemoteHash)) {
   console.log(`[AutoSync] ${newCommitsCount} novo(s) commit(s) detectado(s) no GitHub (${remoteHash.slice(0, 7)}). Atualizando...`);
   lastSeenRemoteHash = remoteHash;

   await execAsync('git pull --rebase origin main || git reset --hard origin/main');
   runMigrations(sqlite);
   await execAsync('node scripts/prepare-worker.mjs');
   await loadWorker();
   await updateCommitInfo();

   console.log(`[AutoSync] Sincronização concluída com sucesso! Atualizado para: ${currentCommit.hash} - ${currentCommit.subject}`);
   return { status: 'updated', commit: currentCommit, newCommits: newCommitsCount };
  }
  return { status: 'up_to_date', commit: currentCommit };
 } catch (err) {
  return { status: 'error', error: err.message };
 } finally {
  isSyncing = false;
 }
}

// Inicializa o worker e informações do git
await updateCommitInfo();
await loadWorker();

// Polling contínuo em segundo plano apenas se houver repositório git local
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL_MS) || 5000;
if (isGitRepo) {
 setInterval(() => {
  syncWithGitHub().catch(() => {});
 }, SYNC_INTERVAL);
}

// Processador contínuo da fila de mensagens (Queue Runner) a cada 1 segundo
setInterval(() => {
 processQueueTick(sqlite, localEnv).catch(err => {
  console.error('[Server Queue Loop Error]', err);
 });
}, 1000);

// Motor Conversacional Inteligente Delivale para atendimento e vendas
function generateSmartDelivaleReply(userText, history = [], systemPrompt = '', cfg = {}, companyName = 'Restaurante') {
  const text = (userText || '').toLowerCase().trim();
  const company = companyName || 'seu estabelecimento';
  const offer = cfg.offer || 'Cardápio digital próprio para delivery com 30 dias grátis de teste, sem taxa de montagem e com integração no WhatsApp.';
  const registration = cfg.aiRegistration || 'Nome do responsável, nome do estabelecimento, cidade e WhatsApp';
  const handoff = cfg.aiHandoff || 'Perfeito! 😊 Seus dados foram anotados e nossa equipe entrará em contato para liberar seu acesso e montar sua demonstração.';

  if (/\b\d{8,12}\b/.test(text.replace(/\D/g, '')) || text.includes('nome:') || text.includes('responsável:') || (text.includes('meu nome') && (text.includes('rua') || text.includes('whats') || text.includes('telefone')))) {
    return `${handoff}\n\nFicou alguma dúvida sobre como você vai receber os pedidos ou como funciona o painel?`;
  }
  if (text.includes('humano') || text.includes('atendente') || text.includes('pessoa real') || text.includes('falar com alguém')) {
    return `Com certeza! Já notifiquei nossa equipe e um atendente humano da Delivale irá assumir o atendimento por aqui. Pode me adiantar qual seria a sua dúvida principal?`;
  }
  if (text.includes('quero testar') || text.includes('como faço pra cadastrar') || text.includes('quero cadastrar') || text.includes('tenho interesse') || text.includes('como começo') || text.includes('pode montar') || text.includes('quero conhecer') || text.includes('sim, quero') || text.includes('vamos testar') || text.includes('pode ser')) {
    return `Excelente decisão! 🎉 O teste é 100% gratuito por 30 dias e nós mesmos deixamos o cardápio digital do ${company} montado e pronto para você conhecer na prática.\n\nPara iniciarmos a liberação, por favor me informe:\n- ${registration.split(';').join('\n- ')}\n\nAssim que me enviar, nossa equipe já começa a montagem!`;
  }
  if (text.includes('quanto custa') || text.includes('qual o valor') || text.includes('mensalidade') || text.includes('preço') || text.includes('preco') || text.includes('taxa') || text.includes('comissão') || text.includes('porcentagem') || text.includes('gratis') || text.includes('grátis')) {
    return `Olá! Na Delivale você tem **30 dias de teste 100% gratuitos** para o ${company}, sem taxa de montagem da loja e sem surpresas. Além disso, **não cobramos comissão por pedido**, diferente de outros aplicativos que chegam a reter até 27% das suas vendas!\n\nVocê gostaria de ver uma demonstração de como ficaria o cardápio digital do seu estabelecimento pelo celular?`;
  }
  if (text.includes('como funciona') || text.includes('o que é') || text.includes('oque é') || text.includes('me explica') || text.includes('como é')) {
    return `A Delivale funciona de forma muito prática: nós montamos o seu cardápio digital interativo com produtos, fotos, categorias e preços. O cliente acessa pelo link no WhatsApp ou Instagram, escolhe os itens e o pedido chega completo no seu WhatsApp com endereço, forma de pagamento e total!\n\nConta também com impressão automática e participação no marketplace da cidade. O ${company} já trabalha com pedidos pelo WhatsApp hoje?`;
  }
  if (text.includes('já tenho') || text.includes('ja tenho') || text.includes('ifood') || text.includes('cardapio') || text.includes('cardápio')) {
    return `Que bom que você já tem estrutura! A Delivale é o complemento ideal: ela não substitui os clientes que já chegam pelo iFood, mas impede que você pague comissões abusivas para os clientes fiéis da sua cidade. Você direciona seu WhatsApp/Instagram para a Delivale com **0% de comissão** e economiza todo mês!\n\nPodemos liberar o teste de 30 dias sem custo para você comparar na prática?`;
  }
  const pureGreetingWords = ['bom dia', 'boa tarde', 'boa noite', 'ola', 'olá', 'oi', 'oie', 'opa', 'e aí', 'e ai', 'salve', 'tudo bem', 'tudo bom', 'como vai'];
  const isGreeting = pureGreetingWords.some(g => text === g || (text.length <= 22 && text.startsWith(g) && !text.includes('quanto') && !text.includes('preço') && !text.includes('como funciona') && !text.includes('cardapio')));
  if (isGreeting) {
    if (text.includes('bom dia')) return 'Olá! Bom dia, tudo bem? Como posso te ajudar hoje? 😊';
    if (text.includes('boa tarde')) return 'Olá! Boa tarde, tudo bem? Como posso te ajudar hoje? 😊';
    if (text.includes('boa noite')) return 'Olá! Boa noite, tudo bem? Como posso te ajudar hoje? 😊';
    return 'Olá! Tudo bem? Como posso te ajudar hoje? 😊';
  }
  return `Com certeza! Na Delivale nosso objetivo é facilitar o atendimento do ${company} e aumentar suas vendas no delivery com cardápio digital próprio e 30 dias de teste gratuito.\n\nGostaria de ver uma demonstração preparada para o seu estabelecimento?`;
}

// Rastreamento de envios automatizados do robô para distinguir de intervenções humanas
const recentBotSends = new Map();

function recordBotSent(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return;
  recentBotSends.set(digits, Date.now());
  if (recentBotSends.size > 2000) {
    const cutoff = Date.now() - 120000;
    for (const [k, v] of recentBotSends.entries()) {
      if (v < cutoff) recentBotSends.delete(k);
    }
  }
}

// Mecanismo anti-duplicação global e controle de concorrência por telefone
const processedWhatsAppKeys = new Set();
const processedEvolutionMessageIds = new Set();
const activePhoneProcessing = new Set();
const recentMessageFingerprints = new Map(); // phoneDigits:userText -> timestamp
const lastReplyPerPhone = new Map();
const recentBotTexts = new Set();

function recordBotText(text) {
  if (!text) return;
  const clean = text.toLowerCase().trim().slice(0, 80);
  recentBotTexts.add(clean);
  if (recentBotTexts.size > 800) {
    const first = recentBotTexts.values().next().value;
    recentBotTexts.delete(first);
  }
}

function isBotText(text) {
  if (!text) return false;
  const clean = text.toLowerCase().trim().slice(0, 80);
  return recentBotTexts.has(clean);
}

function wasRecentlySentByBot(phone, db) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  const ts = recentBotSends.get(digits);
  if (ts && (Date.now() - ts < 120000)) return true;
  if (db) {
    try {
      const recentSend = db.prepare(`
        SELECT id FROM sends 
        WHERE (phone = ? OR phone = ?) AND datetime(opened_at) > datetime('now', '-3 minutes')
        LIMIT 1
      `).get(digits, '55' + digits);
      if (recentSend) return true;

      const recentAi = db.prepare(`
        SELECT id FROM chat_messages 
        WHERE phone = ? AND role = 'model' AND datetime(created_at) > datetime('now', '-3 minutes')
        LIMIT 1
      `).get(digits);
      if (recentAi) return true;
    } catch {}
  }
  return false;
}

function pauseAiForContact(db, phone, reason, durationMinutes = 30) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return;
  const pausedUntil = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO ai_human_interventions (phone, paused_until, reason, detected_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET paused_until = excluded.paused_until, reason = excluded.reason, detected_at = excluded.detected_at
    `).run(digits, pausedUntil, reason, nowIso);
  } catch (err) {
    console.error('[AI Pause DB Error]', err);
  }

  try {
    const contact = db.prepare("SELECT id FROM contacts WHERE phone = ? OR phone = ?").get(digits, '55' + digits);
    if (contact) {
      db.prepare(`
        INSERT INTO contact_events (id, contact_id, event, details, created_at)
        VALUES (?, ?, 'HUMAN_PAUSE', ?, ?)
      `).run(crypto.randomUUID(), contact.id, `IA pausada por ${durationMinutes} min: ${reason}`, nowIso);
    }
  } catch {}
  console.log(`[AI Human Detection] ⏸️ IA pausada para ${digits} por ${durationMinutes} min até ${pausedUntil} (${reason})`);
}

function isAiPausedForContact(db, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  try {
    const row = db.prepare('SELECT paused_until, reason FROM ai_human_interventions WHERE phone = ?').get(digits);
    if (row && new Date(row.paused_until) > new Date()) {
      return row;
    }
    if (row) {
      db.prepare('DELETE FROM ai_human_interventions WHERE phone = ?').run(digits);
    }
  } catch {}
  return false;
}

// Processador de mensagens e eventos recebidos no WhatsApp via IA e Webhooks
async function handleIncomingWhatsAppMessage(payload, db, env, reqOrigin = '') {
  try {
    const eventName = String(payload.event || payload.type || '').toLowerCase();

    // 1. ATUALIZAÇÃO EM TEMPO REAL DE CONEXÃO DA INSTÂNCIA (CONNECTION_UPDATE / connection.update)
    if (eventName.includes('connection')) {
      const instName = payload.instance || payload.data?.instance || payload.sender || '';
      const state = String(payload.data?.state || payload.state || payload.data?.connection || '').toLowerCase();
      if (instName && state) {
        const isConnected = state === 'open' || state === 'connected';
        const nowIso = new Date().toISOString();
        db.prepare('UPDATE instances SET status = ?, last_checked_at = ?, updated_at = ? WHERE name = ?')
          .run(isConnected ? 'CONNECTED' : 'DISCONNECTED', nowIso, nowIso, instName);
        console.log(`[Instance Realtime Update] Instância "${instName}" atualizada para ${isConnected ? 'CONNECTED' : 'DISCONNECTED'} via webhook (${state}).`);
      }
      return;
    }

    const settingsRow = db.prepare('SELECT config_json, key_cipher FROM settings WHERE id = 1').get();
    if (!settingsRow) return;
    const cfg = JSON.parse(settingsRow.config_json);
    const isAiActive = cfg.aiEnabled === true || (cfg.aiEnabled !== false && cfg.aiEnabled !== 'false');
    if (!isAiActive) {
      console.log('[AI Auto-Reply] ⏸️ IA desligada nas configurações. Mensagem ignorada.');
      return;
    }

    // Normalização flexível do payload: Evolution API pode enviar array de mensagens ou objeto único
    const rawData = payload.data || payload;
    let dataList = [];
    if (Array.isArray(rawData)) {
      dataList = rawData;
    } else if (Array.isArray(rawData?.messages)) {
      dataList = rawData.messages;
    } else if (Array.isArray(payload?.messages)) {
      dataList = payload.messages;
    } else {
      dataList = [rawData];
    }

    for (const data of dataList) {
      if (!data) continue;

      // Eventos de presença (digitação do cliente no WhatsApp) NUNCA devem pausar a IA
      if (eventName.includes('presence')) {
        continue;
      }

      const key = data.key || {};
      let targetJid = '';
      if (key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net')) {
        targetJid = key.remoteJidAlt;
      } else if (data.remoteJidAlt && data.remoteJidAlt.includes('@s.whatsapp.net')) {
        targetJid = data.remoteJidAlt;
      } else if (key.remoteJid && !key.remoteJid.includes('@lid')) {
        targetJid = key.remoteJid;
      } else if (key.remoteJidAlt) {
        targetJid = key.remoteJidAlt;
      } else {
        targetJid = key.remoteJid || data.remoteJid || data.from || key.participant || '';
      }

      if (!targetJid || targetJid.includes('@g.us') || targetJid.includes('@broadcast')) continue;

      const phoneDigits = targetJid.split('@')[0].replace(/\D/g, '');
      if (!phoneDigits) continue;

      // 2. Detecção de intervenção humana quando uma mensagem 'fromMe' (enviada pelo WhatsApp) é recebida
      if (key.fromMe || data.fromMe || eventName.includes('send.message')) {
        const wasBot = wasRecentlySentByBot(phoneDigits, db) || (key.remoteJid && wasRecentlySentByBot(key.remoteJid.split('@')[0].replace(/\D/g, ''), db));
        if (!wasBot && cfg.aiHumanDetection !== false) {
          // Mensagem enviada pelo operador humano no celular ou WhatsApp Web!
          console.log(`[AI Human Detection] 👤 Mensagem manual enviada por atendente humano para ${phoneDigits}.`);
          pauseAiForContact(db, phoneDigits, 'Atendente humano respondeu manualmente pelo WhatsApp', cfg.aiHumanPauseMinutes || 30);
        }
        continue;
      }

      // 3. Extração da mensagem enviada pelo cliente
      const msgObj = data.message || {};
      const userText = msgObj.conversation ||
                       msgObj.extendedTextMessage?.text ||
                       msgObj.imageMessage?.caption ||
                       msgObj.videoMessage?.caption ||
                       msgObj.buttonsResponseMessage?.selectedButtonId ||
                       msgObj.templateButtonReplyMessage?.selectedId ||
                       msgObj.listResponseMessage?.singleSelectReply?.selectedRowId ||
                       data.messageText ||
                       data.body ||
                       '';
      if (!userText || typeof userText !== 'string' || !userText.trim()) continue;

      console.log(`[AI Auto-Reply] 📩 Mensagem recebida de ${phoneDigits}: "${userText.trim().slice(0, 60)}"`);

      // 4. Verifica se este contato está em período de pausa por intervenção humana
      const activePause = isAiPausedForContact(db, phoneDigits);
      if (activePause && cfg.aiHumanDetection !== false) {
        console.log(`[AI Auto-Reply] ⏸️ IA pausada para ${phoneDigits} até ${activePause.paused_until} (${activePause.reason}). Resposta suprimida.`);
        // Registra a mensagem no histórico do chat para memória, mas não responde automaticamente
        try {
          db.prepare("INSERT INTO chat_messages (id, phone, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
            .run(crypto.randomUUID(), phoneDigits, userText.trim(), new Date().toISOString());
        } catch {}
        continue;
      }

      let apiKey = env.GEMINI_API_KEY || '';
      if (settingsRow.key_cipher) {
        try { apiKey = await decryptSecret(settingsRow.key_cipher, env); } catch {}
      }

      const contact = db.prepare("SELECT * FROM contacts WHERE phone = ? OR phone = ?").get(phoneDigits, '55' + phoneDigits);
      const companyName = contact?.company || data.pushName || 'Cliente';
      const nowIso = new Date().toISOString();

      // Registra mensagem recebida do cliente no histórico de chat
      try {
        db.prepare("INSERT INTO chat_messages (id, phone, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
          .run(crypto.randomUUID(), phoneDigits, userText.trim(), nowIso);
      } catch (err) {
        console.error('[AI Chat History Error]', err.message);
      }

      // Carrega histórico recente da conversa para multi-turn
      let historyRows = [];
      try {
        historyRows = db.prepare('SELECT role, content FROM chat_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 8').all(phoneDigits).reverse();
      } catch {}

      const formattedContents = [];
      for (const h of historyRows) {
        const role = h.role === 'model' ? 'model' : 'user';
        if (formattedContents.length && formattedContents[formattedContents.length - 1].role === role) {
          formattedContents[formattedContents.length - 1].parts[0].text += '\n' + h.content;
        } else {
          formattedContents.push({ role, parts: [{ text: h.content }] });
        }
      }
      if (formattedContents.length === 0 || formattedContents[formattedContents.length - 1].role !== 'user') {
        formattedContents.push({ role: 'user', parts: [{ text: userText }] });
      }

      // Detecção de solicitação de atendente humano
      const lower = userText.toLowerCase();
      let isHandoffRequest = false;
      if (lower.includes('humano') || lower.includes('atendente') || lower.includes('pessoa real') || lower.includes('falar com alguém') || lower.includes('atendente humano')) {
        isHandoffRequest = true;
      }

      let replyText = '';

      // Freio de Diálogo: se o cliente mandou apenas uma confirmação simples, não reenviar discurso de vendas
      const normalizedShort = userText.toLowerCase().trim().replace(/[.,!?:;]/g, '');
      const shortAcks = ['ok', 'blz', 'beleza', 'obrigado', 'obrigada', 'valeu', 'vlw', 'entendi', 'ta bom', 'tá bom', 'combinado', 'show', 'otimo', 'ótimo', 'perfeito', 'certo', 'legal', 'tmj', 'obg', 'joia', 'jóia', 'muito bom', 'bom dia', 'boa tarde', 'boa noite'];

      const isShortAck = shortAcks.some(ack => normalizedShort === ack || (normalizedShort.length <= 20 && normalizedShort.includes(ack)));

      if (isHandoffRequest) {
        replyText = `Com certeza! Já notifiquei nossa equipe e um atendente humano assumirá o atendimento por aqui em instantes. 🤝 Pode me adiantar qual seria sua principal dúvida?`;
        pauseAiForContact(db, phoneDigits, 'Cliente solicitou atendente humano', 60);
      } else if (cfg.aiStrictControl !== false && isShortAck && historyRows.length >= 2) {
        // Encerramento educado e curto quando o cliente apenas confirma ou agradece
        const politeClosings = [
          'Por nada! Se precisar de qualquer informação sobre a Delivale, estou à disposição por aqui. Um abraço! 😊',
          'Combinado! Qualquer dúvida é só me chamar. Tenha um excelente dia! ✨',
          'Disponha! Ficamos à total disposição. Sucesso com seu estabelecimento! 🤝'
        ];
        replyText = politeClosings[Math.floor(Math.random() * politeClosings.length)];
        console.log(`[AI Dialogue Brake] Resposta curta e controlada enviada para confirmação simples de ${phoneDigits}`);
      } else {
        const temperature = Math.min(1.0, Math.max(0.0, Number(cfg.aiTemperature !== undefined ? cfg.aiTemperature : 0.3)));
        const maxChars = Math.max(80, Math.min(2500, Number(cfg.aiMaxChars || 320)));
        const maxTokens = Math.min(1000, Math.max(60, Math.round((maxChars / 3.0) + 20)));

        let systemPrompt = (cfg.aiPrompt || '').trim();
        if (systemPrompt) {
          systemPrompt = systemPrompt
            .replaceAll('{empresa}', companyName)
            .replaceAll('{oferta}', cfg.offer || '')
            .replaceAll('{cadastro}', cfg.aiRegistration || '')
            .replaceAll('{handoff}', cfg.aiHandoff || '')
            .replaceAll('{instrucoes}', cfg.aiInstructions || '');
        } else {
          systemPrompt = `Você é a atendente virtual e especialista de vendas da Delivale.com no WhatsApp conversando diretamente com o cliente (${companyName}).
Instruções gerais de atendimento:
${cfg.aiInstructions || 'Explique que a Delivale é um portal de pedidos e cardápio digital para delivery com 30 dias grátis.'}

Dados que devem ser solicitados durante a conversa:
${cfg.aiRegistration || 'Nome do responsável, nome do estabelecimento, cidade e WhatsApp.'}

Mensagem ou orientações de conclusão/finalização:
${cfg.aiHandoff || 'Agradeça e informe que a equipe Delivale entrará em contato.'}

Oferta cadastrada:
${cfg.offer || 'Cardápio digital próprio, integração com WhatsApp, 30 dias grátis de teste.'}`;
        }

        systemPrompt += `\n\nCONTROLE ESTRITO DE RESPOSTA E TAMANHO MÁXIMO:
1. Responda em no MÁXIMO ${maxChars} caracteres.
2. Responda APENAS ao que o cliente perguntou de forma direta, concisa e educada. Não despeje a apresentação inteira.
3. Se o cliente tiver uma dúvida específica, responda estritamente aquela dúvida com 1 a 2 frases curtas.
4. Responda APENAS o texto da mensagem de WhatsApp, sem notas ou títulos adicionais.`;

        const preferredModel = cfg.aiModel || env.GEMINI_MODEL || 'gemini-2.5-flash';
        const modelsToTry = [preferredModel, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'].filter((m, i, arr) => m && arr.indexOf(m) === i);
        let geminiResp = null;
        for (const m of modelsToTry) {
          try {
            const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
              method: 'POST',
              headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: formattedContents,
                generationConfig: {
                  temperature,
                  maxOutputTokens: maxTokens
                }
              }),
              signal: AbortSignal.timeout(30000)
            });
            if (resp.ok) {
              geminiResp = resp;
              break;
            } else if (resp.status === 401 || resp.status === 403) {
              geminiResp = resp;
              break;
            }
          } catch (e) {
            console.error('[AI Auto-Reply] Erro ao chamar modelo ' + m, e?.message);
          }
        }

        if (geminiResp && geminiResp.ok) {
          try {
            const geminiData = await geminiResp.json();
            replyText = (geminiData.candidates?.[0]?.content?.parts || [])
              .filter(p => !p.thought && typeof p.text === 'string')
              .map(p => p.text)
              .join('\n')
              .trim();
          } catch (e) {
            console.error('[AI Auto-Reply] Erro ao parsear resposta Gemini:', e);
          }
        }

        if (!replyText) {
          console.log(`[AI Auto-Reply] Gerando resposta resiliente com Motor Delivale para ${phoneDigits}`);
          replyText = generateSmartDelivaleReply(userText, historyRows, systemPrompt, cfg, companyName);
        }

        // Freio de caracteres: corte suave no final da frase antes de exceder o limite
        if (replyText && replyText.length > maxChars) {
          const trimmed = replyText.slice(0, maxChars);
          const lastPunct = Math.max(trimmed.lastIndexOf('.'), trimmed.lastIndexOf('!'), trimmed.lastIndexOf('?'));
          if (lastPunct > maxChars * 0.55) {
            replyText = trimmed.slice(0, lastPunct + 1).trim();
          } else {
            replyText = trimmed.trim() + '...';
          }
        }
      }

      if (!replyText) continue;

      // 5. SELEÇÃO DA INSTÂNCIA DE IA (Regras resilientes para resposta)
      let instance = null;
      const instanceName = payload.instance || data.instance || payload.data?.instance;

      // Prioridade 1: Responde pela instância exata por onde a mensagem chegou
      if (instanceName) {
        instance = db.prepare("SELECT * FROM instances WHERE name = ?").get(instanceName);
        if (instance) {
          const nowIso = new Date().toISOString();
          db.prepare("UPDATE instances SET status = 'CONNECTED', last_checked_at = ?, updated_at = ? WHERE id = ?")
            .run(nowIso, nowIso, instance.id);
          instance.status = 'CONNECTED';
        }
      }

      // Prioridade 2: Instância configurada explicitamente para a IA
      if (!instance && cfg.aiInstanceId && cfg.aiInstanceId !== 'ALL' && cfg.aiInstanceId !== 'AUTO') {
        instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(cfg.aiInstanceId);
      }

      // Prioridade 3: Instância conectada com papel IA ou ALL
      if (!instance) {
        instance = db.prepare("SELECT * FROM instances WHERE status = 'CONNECTED' AND role IN ('IA', 'ALL') ORDER BY last_checked_at DESC LIMIT 1").get();
      }

      // Prioridade 4: Qualquer instância conectada
      if (!instance) {
        instance = db.prepare("SELECT * FROM instances WHERE status = 'CONNECTED' ORDER BY last_checked_at DESC LIMIT 1").get();
      }

      // Prioridade 5: Primeira instância cadastrada
      if (!instance) {
        instance = db.prepare("SELECT * FROM instances ORDER BY updated_at DESC LIMIT 1").get();
      }

      // Regra 5 (FALLBACK EM TEMPO REAL): Se o banco marcava como DISCONNECTED, consulta live a Evolution API
      if (!instance) {
        const candidate = instanceName
          ? db.prepare('SELECT * FROM instances WHERE name = ?').get(instanceName)
          : db.prepare("SELECT * FROM instances WHERE role != 'DISPARO' ORDER BY updated_at DESC LIMIT 1").get() ||
            db.prepare('SELECT * FROM instances ORDER BY updated_at DESC LIMIT 1').get();
        if (candidate) {
          try {
            const tokenCipher = candidate.token_cipher || candidate.instance_token_cipher;
            const token = await decryptSecret(tokenCipher, env);
            const baseUrl = String(candidate.api_url || '').replace(/\/$/, '');
            const checkUrl = candidate.provider === 'EVOLUTION_GO'
              ? `${baseUrl}/instance/status`
              : `${baseUrl}/instance/connectionState/${encodeURIComponent(candidate.name)}`;
            const checkResp = await fetch(checkUrl, {
              headers: { 'apikey': token },
              signal: AbortSignal.timeout(5000)
            });
            if (checkResp.ok) {
              const checkData = await checkResp.json();
              const state = String(checkData?.instance?.state || checkData?.state || checkData?.data?.state || '').toLowerCase();
              if (state === 'open' || state === 'connected' || checkData?.connected || checkData?.data?.loggedIn) {
                const nowIso = new Date().toISOString();
                db.prepare("UPDATE instances SET status = 'CONNECTED', last_checked_at = ?, updated_at = ? WHERE id = ?")
                  .run(nowIso, nowIso, candidate.id);
                candidate.status = 'CONNECTED';
                instance = candidate;
                console.log(`[AI Auto-Reply] Instância "${candidate.name}" revalidada em tempo real como CONECTADA!`);
              }
            }
          } catch (e) {
            console.warn('[AI Auto-Reply] Falha ao verificar instância em tempo real:', e.message);
          }
        }
      }

      if (!instance) {
        console.warn('[AI Auto-Reply] ⚠️ Nenhuma instância WhatsApp conectada para enviar resposta.');
        continue;
      }

      // 6. CÁLCULO DE TEMPO INTELIGENTE CONFORME O TAMANHO DO TEXTO
      let delaySec = 5;
      if (cfg.aiSmartTiming !== false) {
        // Leitura humana: ~1.5 a 3.5 segundos dependendo do tamanho da mensagem recebida
        const readingSec = Math.min(4, Math.max(1.5, (userText.length / 50) + (Math.random() * 1.5)));
        // Digitação humana: média de 32 a 36 caracteres por segundo no celular
        const typingSec = Math.max(2, (replyText.length / 32));
        const calculated = Math.round(readingSec + typingSec);
        const minSec = Math.max(2, Number(cfg.aiMinDelay) || 3);
        const maxSec = Math.max(minSec, Number(cfg.aiMaxDelay) || 25);
        delaySec = Math.min(Math.max(calculated, minSec), maxSec);
        console.log(`[AI Auto-Reply] ⏱️ Tempo inteligente calculado para ${phoneDigits}: ${delaySec}s (leitura ~${readingSec.toFixed(1)}s + digitação ~${typingSec.toFixed(1)}s para ${replyText.length} caracteres)`);
      } else {
        const minSec = Math.max(1, Number(cfg.aiMinDelay) || 5);
        const maxSec = Math.max(minSec, Number(cfg.aiMaxDelay) || 20);
        delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
      }

      // Descriptografa token da instância (suporta token_cipher ou instance_token_cipher)
      const tokenCipher = instance.token_cipher || instance.instance_token_cipher;
      const token = await decryptSecret(tokenCipher, env);
      const baseUrl = String(instance.api_url || '').replace(/\/$/, '');

      // 7. Envia presença "digitando..." (composing) no WhatsApp durante o tempo inteligente
      if (cfg.aiSendPresence !== false && token) {
        try {
          const presUrl = instance.provider === 'EVOLUTION_GO'
            ? `${baseUrl}/chat/sendPresence`
            : `${baseUrl}/chat/sendPresence/${encodeURIComponent(instance.name)}`;
          await fetch(presUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': token },
            body: JSON.stringify({ number: phoneDigits, presence: 'composing', delay: delaySec * 1000 }),
            signal: AbortSignal.timeout(5000)
          });
        } catch {}
      }

      // Aguarda o tempo inteligente simulando digitação humana
      await new Promise(r => setTimeout(r, delaySec * 1000));

      // 8. Re-validação de intervenção humana: se um humano digitou ou respondeu enquanto a IA calculava, cancela
      const doubleCheckPause = isAiPausedForContact(db, phoneDigits);
      if (doubleCheckPause && cfg.aiHumanDetection !== false) {
        console.log(`[AI Auto-Reply] 🚫 Resposta para ${phoneDigits} cancelada pois atendente humano interveio durante a digitação.`);
        continue;
      }

      // 9. Envio da mensagem de resposta ao WhatsApp
      let endpoint = '';
      let bodyData = {};

      if (instance.provider === 'EVOLUTION_GO') {
        endpoint = `${baseUrl}/message/sendText`;
        bodyData = { number: phoneDigits, text: replyText };
      } else {
        endpoint = `${baseUrl}/message/sendText/${encodeURIComponent(instance.name)}`;
        bodyData = {
          number: phoneDigits,
          text: replyText,
          textMessage: { text: replyText }
        };
      }

      recordBotSent(phoneDigits);

      const sendResp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': token },
        body: JSON.stringify(bodyData),
        signal: AbortSignal.timeout(30000)
      });

      const sentIso = new Date().toISOString();
      try {
        db.prepare("INSERT INTO chat_messages (id, phone, role, content, created_at) VALUES (?, ?, 'model', ?, ?)")
          .run(crypto.randomUUID(), phoneDigits, replyText, sentIso);
      } catch {}

      if (sendResp.ok) {
        console.log(`[AI Auto-Reply] ✅ Resposta da IA enviada com sucesso para ${phoneDigits} via instância ${instance.name}!`);
        if (contact) {
          db.prepare("INSERT INTO contact_events (id, contact_id, event, details, created_at) VALUES (?, ?, 'AI_REPLIED', ?, ?)")
            .run(crypto.randomUUID(), contact.id, `IA respondeu cliente (${instance.name}): "${replyText.slice(0, 100)}..."`, sentIso);

          // Se o cliente demonstrar interesse ou intenção de teste, registrar como Interessado
          if (lower.includes('quero') || lower.includes('interesse') || lower.includes('cadastr') || lower.includes('pode montar') || lower.includes('teste') || lower.includes('preço') || lower.includes('quanto custa') || lower.includes('como funciona') || lower.includes('sim')) {
            try {
              db.prepare("UPDATE contacts SET interested = 1, status = 'INTERESTED' WHERE id = ?").run(contact.id);
              db.prepare("INSERT INTO contact_events (id, contact_id, event, details, created_at) VALUES (?, ?, 'INTERESTED', 'Cliente demonstrou interesse na conversa com a IA', ?)")
                .run(crypto.randomUUID(), contact.id, sentIso);
            } catch {}
          }
        }
        db.prepare("INSERT INTO sends (id, company, phone, message, type, opened_at, status, confirmed_at) VALUES (?, ?, ?, ?, 'Atendimento IA', ?, 'sent', ?)")
          .run(crypto.randomUUID(), companyName, phoneDigits, replyText, sentIso, sentIso);
      } else {
        let errJson = null;
        try { errJson = await sendResp.json(); } catch {}
        console.warn(`[AI Auto-Reply] Aviso ao enviar para ${phoneDigits} via ${instance.name}: HTTP ${sendResp.status}`, errJson?.error || errJson);
      }
      return { success: true, replyText, instanceName: instance.name };
    }
  } catch (err) {
    console.error('[AI Auto-Reply Error]', err);
  }
  return { success: false };
}

// =========================================================================
// SINCRONIZAÇÃO EM TEMPO REAL: EVOLUTION API (STATUS DA CONEXÃO + MENSAGENS)
// Garante recebimento e resposta instantânea da IA mesmo se o Webhook externo
// for bloqueado ou redirecionado por firewall/proxy/nuvem.
// =========================================================================
let isEvolutionSyncRunning = false;

async function initEvolutionMessageCache() {
  try {
    const instances = sqlite.prepare("SELECT * FROM instances WHERE provider = 'EVOLUTION_API' OR provider IS NULL").all();
    for (const inst of instances) {
      try {
        const tokenCipher = inst.token_cipher || inst.instance_token_cipher;
        const token = await decryptSecret(tokenCipher, localEnv);
        if (!token) continue;
        const baseUrl = String(inst.api_url || '').replace(/\/$/, '');
        const resp = await fetch(`${baseUrl}/chat/findMessages/${encodeURIComponent(inst.name)}`, {
          method: 'POST',
          headers: { 'apikey': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 20 }),
          signal: AbortSignal.timeout(6000)
        });
        if (resp.ok) {
          const data = await resp.json();
          const records = data.messages?.records || (Array.isArray(data) ? data : []);
          for (const rec of records) {
            const id = rec.id || rec.key?.id;
            if (id) processedEvolutionMessageIds.add(id);
          }
        }
      } catch {}
    }
    console.log(`[Evolution Sync] Cache de mensagens inicializado: ${processedEvolutionMessageIds.size} mensagem(ns) antiga(s) registradas.`);
  } catch (err) {
    console.warn('[Evolution Sync] Inicialização do cache:', err.message);
  }
}

async function syncEvolutionMessagesAndStatus() {
  if (isEvolutionSyncRunning) return;
  isEvolutionSyncRunning = true;
  try {
    const instances = sqlite.prepare("SELECT * FROM instances").all();
    for (const inst of instances) {
      try {
        const tokenCipher = inst.token_cipher || inst.instance_token_cipher;
        const token = await decryptSecret(tokenCipher, localEnv);
        if (!token) continue;
        const baseUrl = String(inst.api_url || '').replace(/\/$/, '');

        // 1. Verificação de status em tempo real com Evolution API
        const checkUrl = inst.provider === 'EVOLUTION_GO'
          ? `${baseUrl}/instance/status`
          : `${baseUrl}/instance/connectionState/${encodeURIComponent(inst.name)}`;
        const stResp = await fetch(checkUrl, {
          headers: { 'apikey': token },
          signal: AbortSignal.timeout(4000)
        });
        let isConnected = false;
        if (stResp.ok) {
          const stData = await stResp.json();
          const state = String(stData?.instance?.state || stData?.state || stData?.data?.state || '').toLowerCase();
          isConnected = state === 'open' || state === 'connected' || !!stData?.connected || !!stData?.data?.loggedIn;
        }
        const nowIso = new Date().toISOString();
        const newStatus = isConnected ? 'CONNECTED' : 'DISCONNECTED';
        if (inst.status !== newStatus) {
          sqlite.prepare("UPDATE instances SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?")
            .run(newStatus, nowIso, nowIso, inst.id);
          inst.status = newStatus;
          console.log(`[Realtime Instance] Instância "${inst.name}" atualizada em tempo real: ${newStatus}`);
        } else {
          sqlite.prepare("UPDATE instances SET last_checked_at = ? WHERE id = ?")
            .run(nowIso, inst.id);
        }

        if (!isConnected) continue;

        // 2. Busca de mensagens recentes para atendimento de IA
        const msgResp = await fetch(`${baseUrl}/chat/findMessages/${encodeURIComponent(inst.name)}`, {
          method: 'POST',
          headers: { 'apikey': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 10 }),
          signal: AbortSignal.timeout(6000)
        });
        if (!msgResp.ok) continue;
        const msgData = await msgResp.json();
        const records = msgData.messages?.records || (Array.isArray(msgData) ? msgData : []);

        for (const rec of records) {
          const recId = rec.id || '';
          const keyId = rec.key?.id || '';
          if ((recId && processedEvolutionMessageIds.has(recId)) || (keyId && processedEvolutionMessageIds.has(keyId))) continue;
          if (recId) processedEvolutionMessageIds.add(recId);
          if (keyId) processedEvolutionMessageIds.add(keyId);

          if (processedEvolutionMessageIds.size > 8000) {
            const first = processedEvolutionMessageIds.values().next().value;
            processedEvolutionMessageIds.delete(first);
          }

          // Filtro anti-retroatividade: não responder mensagens antigas da conversa (mais de 8 minutos)
          const msgTimeSec = Number(rec.messageTimestamp || rec.timestamp || 0);
          if (msgTimeSec > 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec - msgTimeSec > 480) {
              continue;
            }
          }

          const key = rec.key || {};
          const remoteJid = key.remoteJid || '';
          if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) continue;

          // Se enviada pelo operador humano no celular (fromMe = true)
          if (key.fromMe) {
            const targetJid = key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net') ? key.remoteJidAlt : (key.remoteJid || '');
            const phone = targetJid.split('@')[0].replace(/\D/g, '');
            if (phone && !wasRecentlySentByBot(phone, sqlite)) {
              console.log(`[Evolution Sync] 👤 Atendente humano respondeu manualmente no celular para ${phone}`);
              pauseAiForContact(sqlite, phone, 'Atendente humano respondeu manualmente pelo WhatsApp', 30);
            }
            continue;
          }

          // Se o robô respondeu a este número nos últimos 6 segundos, evita rajada
          const targetJid = key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net') ? key.remoteJidAlt : (key.remoteJid || '');
          const phone = targetJid.split('@')[0].replace(/\D/g, '');
          if (phone && wasRecentlySentByBot(phone, sqlite)) {
            continue;
          }

          // Mensagem recebida de cliente no WhatsApp!
          console.log(`[Evolution Sync] 📩 Nova mensagem recebida de cliente na instância "${inst.name}"!`);
          const simulatedPayload = {
            event: 'messages.upsert',
            instance: inst.name,
            data: rec
          };
          await handleIncomingWhatsAppMessage(simulatedPayload, sqlite, localEnv, '');
        }
      } catch (e) {
        // Ignora erros transitórios
      }
    }
  } catch (err) {
    console.error('[Evolution Sync Error]', err.message);
  } finally {
    isEvolutionSyncRunning = false;
  }
}

// Inicia o poller contínuo em tempo real (a cada 2.5s)
initEvolutionMessageCache().then(() => {
  setInterval(() => {
    syncEvolutionMessagesAndStatus().catch(() => {});
  }, 2500);
});

// 5. Servidor HTTP com suporte a Webhook e Proxy
const server = createServer(async (req, res) => {
 try {
  const clientOrigin = req.headers.origin;
  const forwardedProto = req.headers['x-forwarded-proto'] || 'http';
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const origin = clientOrigin || `${forwardedProto}://${forwardedHost}`;
  const url = new URL(req.url, origin);

  // Webhook para recebimento de mensagens e respostas da IA
  if (url.pathname.replace(/\/$/, '') === '/api/webhook' || url.pathname.replace(/\/$/, '') === '/webhook') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'active', message: 'Webhook EnvioZap operacional', url: `${origin}/api/webhook` }));
      return;
    }
    if (req.method === 'POST') {
      let rawBody = '';
      req.on('data', chunk => { rawBody += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(rawBody || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
          handleIncomingWhatsAppMessage(payload, sqlite, localEnv, origin).catch(err => {
            console.error('[Webhook AI Error]', err);
          });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Configuração automática do Webhook na Evolution API
  if (url.pathname.match(/^\/api\/instances\/[^/]+\/webhook$/) && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const inst = sqlite.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!inst) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Instância não encontrada.' }));
      return;
    }
    try {
      const tokenCipher = inst.token_cipher || inst.instance_token_cipher;
      const token = await decryptSecret(tokenCipher, localEnv);
      const baseUrl = String(inst.api_url || '').replace(/\/$/, '');
      const webhookUrl = `${origin}/api/webhook`;

      let setUrl = `${baseUrl}/webhook/set/${encodeURIComponent(inst.name)}`;
      // Compatibilidade universal Evolution API v2 (requer "webhook" aninhado) e v1 (campos planos)
      let bodyData = {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: [
            'MESSAGES_UPSERT',
            'SEND_MESSAGE',
            'CONNECTION_UPDATE'
          ]
        },
        enabled: true,
        url: webhookUrl,
        webhookByEvents: false,
        events: [
          'MESSAGES_UPSERT',
          'messages.upsert',
          'SEND_MESSAGE',
          'send.message',
          'CONNECTION_UPDATE',
          'connection.update'
        ]
      };
      if (inst.provider === 'EVOLUTION_GO') {
        setUrl = `${baseUrl}/webhook`;
        bodyData = {
          enabled: true,
          url: webhookUrl,
          events: ['messages.upsert', 'messages', 'presence.update', 'send.message', 'connection.update']
        };
      }

      const resp = await fetch(setUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': token },
        body: JSON.stringify(bodyData),
        signal: AbortSignal.timeout(15000)
      });
      let respData = {};
      try { respData = await resp.json(); } catch {}

      res.writeHead(resp.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: resp.ok,
        status: resp.status,
        webhookUrl,
        response: respData
      }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Consulta e gerenciamento de intervenções humanas (IA pausada)
  if (url.pathname === '/api/ai/human-interventions' && req.method === 'GET') {
    try {
      const rows = sqlite.prepare(`
        SELECT h.phone, h.paused_until, h.reason, h.detected_at, c.company
        FROM ai_human_interventions h
        LEFT JOIN contacts c ON c.phone = h.phone OR c.phone = '55' || h.phone
        WHERE datetime(h.paused_until) > datetime('now')
        ORDER BY h.detected_at DESC
      `).all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ interventions: rows }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  if (url.pathname.startsWith('/api/ai/human-interventions/') && req.method === 'DELETE') {
    const phone = decodeURIComponent(url.pathname.slice('/api/ai/human-interventions/'.length)).replace(/\D/g, '');
    try {
      sqlite.prepare('DELETE FROM ai_human_interventions WHERE phone = ?').run(phone);
      const contact = sqlite.prepare("SELECT id FROM contacts WHERE phone = ? OR phone = ?").get(phone, '55' + phone);
      if (contact) {
        sqlite.prepare(`
          INSERT INTO contact_events (id, contact_id, event, details, created_at)
          VALUES (?, ?, 'HUMAN_PAUSE_CLEARED', 'IA reativada manualmente pelo operador', ?)
        `).run(crypto.randomUUID(), contact.id, new Date().toISOString());
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, phone }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // Endpoint de Teste Interativo da IA em Tempo Real
  if (url.pathname === '/api/ai/test' && req.method === 'POST') {
    let testBody = '';
    req.on('data', chunk => { testBody += chunk; });
    req.on('end', async () => {
      try {
        const { message, phone, company } = JSON.parse(testBody || '{}');
        const testText = (message || 'Olá, como funciona o cardápio digital e teste da Delivale?').trim();
        const testPhone = (phone || '5511999998888').replace(/\D/g, '');
        const simulatedPayload = {
          event: 'messages.upsert',
          instance: 'EnvioZap',
          data: {
            key: {
              remoteJid: `${testPhone}@s.whatsapp.net`,
              fromMe: false,
              id: 'test-' + Date.now()
            },
            pushName: company || 'Cliente Teste',
            message: { conversation: testText }
          }
        };
        const aiResult = await handleIncomingWhatsAppMessage(simulatedPayload, sqlite, localEnv, origin);
        const lastMsgs = sqlite.prepare("SELECT role, content, created_at FROM chat_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 4").all(testPhone);
        const modelReply = aiResult?.replyText || lastMsgs.find(m => m.role === 'model')?.content || 'Resposta gerada com sucesso pela IA.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, reply: modelReply, userMessage: testText, messages: lastMsgs, model: 'Gemini' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Servir biblioteca SheetJS para leitura de arquivos Excel (.xlsx, .xls)
  if (url.pathname === '/vendor/xlsx.full.min.js') {
    const xlsxFile = path.join(process.cwd(), 'node_modules/xlsx/dist/xlsx.full.min.js');
    if (fs.existsSync(xlsxFile)) {
      const data = fs.readFileSync(xlsxFile);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(data);
      return;
    }
  }

  // Endpoint de Sincronização Instantânea / Webhook do GitHub
  if (url.pathname === '/api/sync') {
   if (req.method === 'POST') {
    const result = await syncWithGitHub();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...result, currentCommit, lastSyncAt }));
    return;
   }
   if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
     active: isGitRepo,
     branch: 'main',
     intervalMs: SYNC_INTERVAL,
     currentCommit,
     lastSyncAt,
     isSyncing,
     isGitRepo
    }));
    return;
   }
  }

  // Interceptação de DELETE /api/queue para garantir limpeza 100% segura
  if (url.pathname === '/api/queue' && req.method === 'DELETE') {
   try {
    const rows = sqlite.prepare('SELECT id, contact_id FROM send_queue').all();
    for (const r of rows) {
     sqlite.prepare('DELETE FROM send_queue WHERE id=?').run(r.id);
     if (r.contact_id) {
      sqlite.prepare("UPDATE contacts SET status='AGENDA' WHERE id=?").run(r.contact_id);
     }
    }
    sqlite.prepare("UPDATE contacts SET status='AGENDA' WHERE status='QUEUED'").run();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, cleared: rows.length }));
    return;
   } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
   }
  }

  // Consulta em TEMPO REAL de todas as instâncias (Live Health Check)
  if ((url.pathname === '/api/instances/live' || url.pathname === '/api/instances/check-all') && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const rows = sqlite.prepare("SELECT id, name, status, COALESCE(provider, 'EVOLUTION_API') AS provider, api_url AS apiUrl, token_cipher, instance_token_cipher, last_checked_at AS lastCheckedAt, rest_until AS restUntil, sent_in_cycle AS sentInCycle, min_seconds AS minSeconds, max_seconds AS maxSeconds, messages_per_cycle AS messagesPerCycle, rest_minutes AS restMinutes, COALESCE(role, 'ALL') AS role FROM instances ORDER BY name").all();
      const nowIso = new Date().toISOString();
      const updatedList = await Promise.all(rows.map(async (row) => {
        let connected = false;
        let liveState = 'disconnected';
        try {
          const tokenCipher = row.token_cipher || row.instance_token_cipher;
          const token = await decryptSecret(tokenCipher, localEnv);
          const baseUrl = String(row.apiUrl || '').replace(/\/$/, '');
          const checkUrl = row.provider === 'EVOLUTION_GO'
            ? `${baseUrl}/instance/status`
            : `${baseUrl}/instance/connectionState/${encodeURIComponent(row.name)}`;
          const checkResp = await fetch(checkUrl, {
            headers: { 'apikey': token },
            signal: AbortSignal.timeout(6000)
          });
          if (checkResp.ok) {
            const checkData = await checkResp.json();
            liveState = String(checkData?.instance?.state || checkData?.state || checkData?.data?.state || '').toLowerCase();
            connected = liveState === 'open' || liveState === 'connected' || !!checkData?.connected || !!checkData?.data?.loggedIn;
          }
        } catch (err) {
          liveState = 'unreachable';
        }
        const newStatus = connected ? 'CONNECTED' : 'DISCONNECTED';
        try {
          sqlite.prepare("UPDATE instances SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?")
            .run(newStatus, nowIso, nowIso, row.id);
        } catch {}
        return {
          id: row.id,
          name: row.name,
          status: newStatus,
          provider: row.provider,
          apiUrl: row.apiUrl,
          lastCheckedAt: nowIso,
          restUntil: row.restUntil,
          sentInCycle: row.sentInCycle,
          minSeconds: row.minSeconds,
          maxSeconds: row.maxSeconds,
          messagesPerCycle: row.messagesPerCycle,
          restMinutes: row.restMinutes,
          role: row.role,
          liveState
        };
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ instances: updatedList, checkedAt: nowIso }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // Interceptação de DELETE /api/instances/:id com limpeza completa
  if (url.pathname.startsWith('/api/instances/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/instances/'.length));
    try {
      const inst = sqlite.prepare('SELECT * FROM instances WHERE id = ?').get(id);
      if (inst) {
        // Tentativa de logout/exclusão na Evolution API (best effort)
        try {
          const tokenCipher = inst.token_cipher || inst.instance_token_cipher;
          const token = await decryptSecret(tokenCipher, localEnv);
          const baseUrl = String(inst.api_url || '').replace(/\/$/, '');
          const delUrl = inst.provider === 'EVOLUTION_GO'
            ? `${baseUrl}/instance/delete`
            : `${baseUrl}/instance/delete/${encodeURIComponent(inst.name)}`;
          await fetch(delUrl, {
            method: 'DELETE',
            headers: { 'apikey': token },
            signal: AbortSignal.timeout(4000)
          });
        } catch {}
      }

      sqlite.prepare('DELETE FROM instances WHERE id=?').run(id);

      // Limpa referência nas configurações se esta instância estava selecionada
      try {
        const sRow = sqlite.prepare('SELECT config_json FROM settings WHERE id = 1').get();
        if (sRow) {
          const cfg = JSON.parse(sRow.config_json);
          let changed = false;
          if (cfg.aiInstanceId === id) { cfg.aiInstanceId = ''; changed = true; }
          if (cfg.disparoInstanceId === id) { cfg.disparoInstanceId = ''; changed = true; }
          if (changed) {
            sqlite.prepare('UPDATE settings SET config_json = ?, updated_at = ? WHERE id = 1')
              .run(JSON.stringify(cfg), new Date().toISOString());
          }
        }
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deletedId: id }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // Montagem do Request Web padrão
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
   if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  if (url.origin && url.origin !== 'null') {
   headers.set('Origin', url.origin);
  }
  let body = '';
  for await (const chunk of req) {
   body += chunk.toString();
   if (body.length > 250000) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Reduza o tamanho das informações.' }));
    return;
   }
  }
  const request = new Request(url, {
   method: req.method,
   headers,
   ...(['GET', 'HEAD'].includes(req.method) ? {} : { body })
  });

  if (!currentWorker) {
   await loadWorker();
  }

  const response = await currentWorker.fetch(request, localEnv, {});

  // Polyfill transparente de window.confirm para páginas HTML dentro de iframes
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
   let html = await response.text();
   const polyfill = `
<script>
// Polyfill seguro de window.confirm para ambientes iframe/sandbox
if (window.self !== window.top) {
  window.confirm = function() { return true; };
}
// Indicador visual de sincronização automática com GitHub
document.addEventListener('DOMContentLoaded', () => {
  const brand = document.querySelector('.brand');
  if (brand && !document.getElementById('sync-indicator')) {
    const badge = document.createElement('span');
    badge.id = 'sync-indicator';
    badge.style = 'margin-left:auto;font-size:12px;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.15);padding:3px 10px;border-radius:12px;color:#fff;cursor:pointer;';
    badge.title = 'Sincronização automática com GitHub ativa (branch main). Clique para sincronizar agora.';
    badge.innerHTML = '● GitHub: main <span id="sync-icon" style="display:inline-block;transition:transform 0.5s;">🔄</span>';
    badge.onclick = async () => {
      const icon = document.getElementById('sync-icon');
      if (icon) icon.style.transform = 'rotate(360deg)';
      try {
        const res = await fetch('/api/sync', { method: 'POST' });
        const d = await res.json();
        badge.title = 'Último commit: ' + (d.commit?.subject || d.message || 'Atualizado');
      } catch {}
    };
    brand.append(badge);
  }
});
</script>
`;
   html = html.replace('</head>', polyfill + '</head>');
   const resHeaders = Object.fromEntries(response.headers);
   delete resHeaders['content-length'];
   delete resHeaders['content-encoding'];
   res.writeHead(response.status, { ...resHeaders, 'Content-Length': Buffer.byteLength(html) });
   res.end(html);
   return;
  }

  const resHeaders = Object.fromEntries(response.headers);
  delete resHeaders['content-encoding'];
  delete resHeaders['content-length'];
  delete resHeaders['transfer-encoding'];
  delete resHeaders['connection'];
  delete resHeaders['keep-alive'];
  const buffer = Buffer.from(await response.arrayBuffer());
  resHeaders['content-length'] = buffer.length;
  let statusCode = response.status;
  if (url.pathname.startsWith('/api/')) {
   if (statusCode === 403) statusCode = 400;
   else if (statusCode === 502 || statusCode === 503 || statusCode === 504) statusCode = 500;
  }
  res.writeHead(statusCode, resHeaders);
  res.end(buffer);
 } catch (err) {
  console.error('Server error:', err);
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Não foi possível processar a solicitação.' }));
 }
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
 console.log(`EnvioZap iniciado na porta ${PORT} com Auto-Sync GitHub ativo a cada ${SYNC_INTERVAL / 1000}s na branch main`);
});
