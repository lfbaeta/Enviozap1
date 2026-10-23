import crypto from 'node:crypto';
import { getInstanceFollowupConfig, DEFAULT_FOLLOWUP_RULES_PROMPT, generateFollowupWithGemini, isAiPausedForContact, scheduleNextFollowup, recordBotSent } from '../server.mjs';
import { decryptSecret } from '../queue-runner.mjs';

// Helpers
export const getNow = () => new Date().toISOString();

export async function scheduleAfterAiReply(db, instance, remoteJid, phone) {
  const nowIso = getNow();
  db.prepare(`UPDATE followups SET status = 'cancelled', cancel_reason = 'client_replied', updated_at = ? 
              WHERE instance = ? AND remote_jid = ? AND status = 'scheduled'`).run(nowIso, instance, remoteJid);

  const cfg = getInstanceFollowupConfig(db, instance);
  if (!cfg.enabled) return;

  const firstAttempt = cfg.attempts.find(a => a.attempt === 1);
  if (!firstAttempt) return;

  let ms = firstAttempt.interval * 60 * 1000;
  if (firstAttempt.unit === 'hours') ms *= 60;
  else if (firstAttempt.unit === 'days') ms *= 60 * 24;
  
  const scheduledAt = new Date(Date.now() + ms).toISOString();
  db.prepare(`INSERT INTO followups (id, instance, remote_jid, phone, attempt_number, scheduled_at, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
    .run(crypto.randomUUID(), instance, remoteJid, phone, 1, scheduledAt, nowIso, nowIso);
}

export function cancelPendingFollowups(db, instance, remoteJid, reason = 'client_replied') {
  db.prepare(`UPDATE followups SET status = 'cancelled', cancel_reason = ?, updated_at = ? 
              WHERE instance = ? AND remote_jid = ? AND status = 'scheduled'`).run(reason, getNow(), instance, remoteJid);
}

let isFollowupRunning = false;
let lastCrashCheckAt = 0;

export async function processFollowupTick(db, env) {
  if (isFollowupRunning) return;
  isFollowupRunning = true;

  try {
    const nowMs = Date.now();
    const nowIso = getNow();

    // Recuperação de crash periódica
    if (nowMs - lastCrashCheckAt > 60000) {
      lastCrashCheckAt = nowMs;
      db.prepare(`UPDATE followups SET status = 'uncertain', cancel_reason = 'recovered_after_crash', updated_at = ?
                  WHERE status = 'processing' AND (strftime('%s', ?) - strftime('%s', updated_at)) > 300`)
        .run(nowIso, nowIso);
    }

    // Busca candidatos
    const candidates = db.prepare(`SELECT * FROM followups WHERE status = 'scheduled' AND datetime(scheduled_at) <= datetime(?)
                                   ORDER BY scheduled_at ASC LIMIT 2`).all(nowIso);

    for (const item of candidates) {
      if (!db.prepare("UPDATE followups SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'scheduled'").run(nowIso, item.id).changes) continue;
      
      // ... Lógica de validação e envio (mesma que no server.mjs) ...
      // ... (será preenchido na próxima iteração ou copiado daqui)
      console.log(`[Follow-up] Processando ${item.phone}`);
      db.prepare("UPDATE followups SET status = 'sent', updated_at = ? WHERE id = ?").run(getNow(), item.id);
    }
  } catch (err) {
    console.error('[AI Follow-up Scheduler Loop Error]', err);
  } finally {
    isFollowupRunning = false;
  }
}
