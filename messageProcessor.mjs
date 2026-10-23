import crypto from 'node:crypto';

export async function processIncomingMessage(db, payload, env, {
  recordBotSent,
  wasRecentlySentByBot,
  pauseAiForContact,
  cancelPendingFollowups,
  markConversationCycleStatus,
  rotateConversationCycle,
  isAiPausedForContact,
  generateSmartDelivaleReply,
  getInstanceFollowupConfig,
  DEFAULT_FOLLOWUP_RULES_PROMPT,
  detectClientOptOut,
  recentMessageFingerprints,
  decryptSecret
}) {
  const eventName = payload.event || '';
  const instanceName = String(payload.instance || payload.data?.instance || '').trim();
  const pid = process.pid;

  // 1. Deduplicação Atômica e Persistente (Obrigatória)
  const rawData = payload.data || payload;
  const data = Array.isArray(rawData) ? rawData[0] : (rawData?.messages ? rawData.messages[0] : rawData);
  if (!data) return;
  const key = data.key || {};
  const incomingId = String(key.id || data.id || data.messageId || '').trim();
  
  if (!incomingId || !instanceName) return;

  const dedupKey = `${instanceName}:${incomingId}`;
  
  // Claim Atômico
  try {
    db.prepare('INSERT INTO processed_evolution_messages (id, processed_at) VALUES (?, ?)')
      .run(dedupKey, new Date().toISOString());
  } catch (e) {
    console.log(`[${pid}] [msg] ${instanceName} | ${incomingId} | Evento duplicado ignorado.`);
    return;
  }

  console.log(`[${pid}] [msg] ${instanceName} | ${incomingId} | Origem: ${eventName} | Recebida.`);

  // TODO: Adicionar lógica completa de saudação e resposta aqui...
  // db.prepare('...').run(...)
}
