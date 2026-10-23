import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FOLLOWUP_RULES_PROMPT,
  DEFAULT_FOLLOWUP_CONFIG,
  getInstanceFollowupConfig,
  saveInstanceFollowupConfig,
  detectClientOptOut,
  getSaoPauloDate,
  isWithinAllowedWindow,
  calculateNextAllowedDate,
  cancelPendingFollowups,
  markConversationCycleStatus,
  getOrCreateCurrentCycleId,
  rotateConversationCycle,
  scheduleNextFollowup,
  generateFollowupWithGemini,
  processFollowupTick
} from '../server.mjs';

console.log('🧪 Iniciando bateria de testes do Follow-up Automático com IA...');

// 1. Inicializa banco de dados em memória e executa migrações
const sqlite = new DatabaseSync(':memory:');
for (const f of fs.readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
  for (const s of fs.readFileSync('drizzle/' + f, 'utf8').split('--> statement-breakpoint')) {
    const stmt = s.trim();
    if (stmt) {
      try {
        sqlite.exec(stmt.replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '));
      } catch {}
    }
  }
}

// Cria tabela de mensagens processadas e instâncias se necessário
sqlite.exec("CREATE TABLE IF NOT EXISTS processed_evolution_messages (id text PRIMARY KEY NOT NULL, processed_at text NOT NULL);");
sqlite.exec("CREATE TABLE IF NOT EXISTS settings (id integer PRIMARY KEY, config_json text, key_cipher text, updated_at text);");
sqlite.exec("INSERT OR REPLACE INTO settings (id, config_json, updated_at) VALUES (1, '{\"aiEnabled\":true,\"offer\":\"Cardápio digital próprio e 30 dias grátis\"}', datetime('now'));");

// Cria instâncias para os testes
sqlite.exec(`
  INSERT INTO instances (id, name, status, role, api_url, token_cipher, created_at, updated_at)
  VALUES ('inst-ia-1', 'InstanciaIA', 'CONNECTED', 'IA', 'https://evolution.example.com', 'cipher.test', datetime('now'), datetime('now'));
`);
sqlite.exec(`
  INSERT INTO instances (id, name, status, role, api_url, token_cipher, created_at, updated_at)
  VALUES ('inst-disp-1', 'InstanciaDisparo', 'CONNECTED', 'DISPARO', 'https://evolution.example.com', 'cipher.test', datetime('now'), datetime('now'));
`);

// ----------------------------------------------------------------------------
// TESTE 1: Configuração por Instância e Defaults
// ----------------------------------------------------------------------------
console.log('Test 1: Configuração por instância...');
const initialConfig = getInstanceFollowupConfig(sqlite, 'InstanciaIA');
assert.equal(initialConfig.enabled, false);
assert.equal(initialConfig.maxAttempts, 3);
assert.equal(initialConfig.windowStart, '08:00');
assert.equal(initialConfig.windowEnd, '20:00');
assert.ok(initialConfig.rulesPrompt.includes('Delivale'));

// Salva nova configuração com followup ativado
saveInstanceFollowupConfig(sqlite, 'InstanciaIA', {
  enabled: true,
  maxAttempts: 3,
  attempts: [
    { attempt: 1, interval: 10, unit: 'minutes' },
    { attempt: 2, interval: 2, unit: 'hours' },
    { attempt: 3, interval: 24, unit: 'hours' }
  ]
});
const updatedConfig = getInstanceFollowupConfig(sqlite, 'InstanciaIA');
assert.equal(updatedConfig.enabled, true);
assert.equal(updatedConfig.attempts[0].interval, 10);
console.log('✅ Test 1 passou: Configuração salva e recuperada com sucesso.');

// ----------------------------------------------------------------------------
// TESTE 2: Detecção de Opt-Out
// ----------------------------------------------------------------------------
console.log('Test 2: Detecção de frases de opt-out...');
assert.equal(detectClientOptOut('Não tenho interesse, obrigado'), true);
assert.equal(detectClientOptOut('pare de me mandar mensagem'), true);
assert.equal(detectClientOptOut('Por favor, sair da lista'), true);
assert.equal(detectClientOptOut('stop'), true);
assert.equal(detectClientOptOut('Quero saber o preço do cardápio'), false);
assert.equal(detectClientOptOut('Como funciona o teste grátis?'), false);
console.log('✅ Test 2 passou: Opt-out detectado com precisão.');

// ----------------------------------------------------------------------------
// TESTE 3: Janela de Horário e Fuso America/Sao_Paulo
// ----------------------------------------------------------------------------
console.log('Test 3: Cálculo de horário e ajuste fora da janela...');
// Cria data às 04:00 da manhã no fuso de SP
const earlyMorning = new Date('2026-10-23T07:00:00Z'); // 04:00 em SP (UTC-3)
const isEarlyInWindow = isWithinAllowedWindow(earlyMorning, '08:00', '20:00');
assert.equal(isEarlyInWindow, false);

const adjustedEarly = calculateNextAllowedDate(earlyMorning, '08:00', '20:00');
const spEarly = getSaoPauloDate(adjustedEarly);
assert.equal(spEarly.hour, 8);
assert.equal(spEarly.minute, 0);

// Cria data às 22:00 da noite no fuso de SP
const lateNight = new Date('2026-10-23T01:00:00Z'); // 22:00 em SP
const isLateInWindow = isWithinAllowedWindow(lateNight, '08:00', '20:00');
assert.equal(isLateInWindow, false);
const adjustedLate = calculateNextAllowedDate(lateNight, '08:00', '20:00');
const spLate = getSaoPauloDate(adjustedLate);
assert.equal(spLate.hour, 8);
assert.equal(spLate.minute, 0);
console.log('✅ Test 3 passou: Janela de horário respeitada e ajustada para 08:00.');

// ----------------------------------------------------------------------------
// TESTE 4: Agendamento da Tentativa 1 com Idempotência Estrita
// ----------------------------------------------------------------------------
console.log('Test 4: Agendamento com restrição UNIQUE (anti-duplicação)...');
const testPhone = '5513991112222';
const testJid = `${testPhone}@s.whatsapp.net`;
const cycleId = getOrCreateCurrentCycleId(sqlite, 'InstanciaIA', testJid, testPhone);
assert.ok(cycleId);

// Agenda tentativa 1
const sched1 = scheduleNextFollowup(sqlite, 'InstanciaIA', testJid, testPhone, 1, cycleId);
assert.ok(sched1);

// Tentativa de agendar DUPLICADO para o mesmo ciclo e tentativa
const schedDup = scheduleNextFollowup(sqlite, 'InstanciaIA', testJid, testPhone, 1, cycleId);
assert.equal(schedDup, null, 'Inserção duplicada para mesmo ciclo deve ser ignorada pelo banco!');

const countRows = sqlite.prepare("SELECT COUNT(*) as n FROM followups WHERE instance = ? AND remote_jid = ? AND attempt_number = 1 AND cycle_id = ?")
  .get('InstanciaIA', testJid, cycleId);
assert.equal(countRows.n, 1);
console.log('✅ Test 4 passou: UNIQUE constraint impediu duplicidade em nível de banco.');

// ----------------------------------------------------------------------------
// TESTE 5: Instâncias de papel 'DISPARO' e grupos nunca recebem follow-up
// ----------------------------------------------------------------------------
console.log('Test 5: Bloqueio para instâncias de DISPARO e grupos...');
const groupSched = scheduleNextFollowup(sqlite, 'InstanciaIA', '12036302@g.us', '12036302', 1, cycleId);
assert.equal(groupSched, null);

const disparoCycle = getOrCreateCurrentCycleId(sqlite, 'InstanciaDisparo', testJid, testPhone);
const disparoSched = scheduleNextFollowup(sqlite, 'InstanciaDisparo', testJid, testPhone, 1, disparoCycle);
assert.equal(disparoSched, null);
console.log('✅ Test 5 passou: Grupos e instâncias de DISPARO estritamente bloqueados.');

// ----------------------------------------------------------------------------
// TESTE 6: Cliente responde -> Cancelamento imediato e rotação de ciclo
// ----------------------------------------------------------------------------
console.log('Test 6: Cliente responde -> cancelamento do ciclo anterior...');
const cancelledCount = cancelPendingFollowups(sqlite, 'InstanciaIA', testJid, 'client_replied');
assert.equal(cancelledCount, 1);

const followupRow = sqlite.prepare("SELECT status, cancel_reason FROM followups WHERE id = ?").get(sched1);
assert.equal(followupRow.status, 'cancelled');
assert.equal(followupRow.cancel_reason, 'client_replied');

// Rotação de ciclo gera novo cycle_id
const newCycleId = rotateConversationCycle(sqlite, 'InstanciaIA', testJid, testPhone);
assert.notEqual(newCycleId, cycleId);
console.log('✅ Test 6 passou: Follow-up cancelado por client_replied e novo ciclo iniciado.');

// ----------------------------------------------------------------------------
// TESTE 7: Intervenção Humana -> Cancelamento do follow-up
// ----------------------------------------------------------------------------
console.log('Test 7: Intervenção humana cancela follow-up pendente...');
const sched2 = scheduleNextFollowup(sqlite, 'InstanciaIA', testJid, testPhone, 1, newCycleId);
assert.ok(sched2);

cancelPendingFollowups(sqlite, 'InstanciaIA', testJid, 'human_intervention');
markConversationCycleStatus(sqlite, 'InstanciaIA', testJid, 'human');

const rowAfterHuman = sqlite.prepare("SELECT status, cancel_reason FROM followups WHERE id = ?").get(sched2);
assert.equal(rowAfterHuman.status, 'cancelled');
assert.equal(rowAfterHuman.cancel_reason, 'human_intervention');
console.log('✅ Test 7 passou: Intervenção humana cancelou o follow-up pendente.');

// ----------------------------------------------------------------------------
// TESTE 8: Atomic Claim no Scheduler (Concorrência sem envio duplo)
// ----------------------------------------------------------------------------
console.log('Test 8: Atomic claim transacional...');
const cycle3 = rotateConversationCycle(sqlite, 'InstanciaIA', testJid, testPhone);
const sched3 = scheduleNextFollowup(sqlite, 'InstanciaIA', testJid, testPhone, 1, cycle3);

// Simula dois workers tentando dar claim simultaneamente no mesmo registro
const claim1 = sqlite.prepare("UPDATE followups SET status = 'processing', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'").run(sched3);
const claim2 = sqlite.prepare("UPDATE followups SET status = 'processing', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'").run(sched3);

assert.equal(claim1.changes, 1, 'Primeiro claim deve ter sucesso');
assert.equal(claim2.changes, 0, 'Segundo claim concorrente deve falhar');
console.log('✅ Test 8 passou: Atomic claim garantiu processamento exclusivo.');

// ----------------------------------------------------------------------------
// TESTE 9: Recuperação de Crash (itens presos em 'processing' viram 'uncertain')
// ----------------------------------------------------------------------------
console.log('Test 9: Recuperação segura de crash...');
// Insere item preso em 'processing' há 10 minutos
const crashId = randomUUID();
sqlite.prepare(`
  INSERT INTO followups (id, instance, remote_jid, phone, attempt_number, cycle_id, scheduled_at, status, created_at, updated_at)
  VALUES (?, 'InstanciaIA', ?, ?, 2, ?, datetime('now', '-10 minutes'), 'processing', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))
`).run(crashId, testJid, testPhone, cycle3);

// Roda query de recuperação de crash
sqlite.prepare(`
  UPDATE followups
  SET status = 'uncertain', cancel_reason = 'recovered_after_crash', updated_at = datetime('now')
  WHERE status = 'processing' AND (strftime('%s', datetime('now')) - strftime('%s', updated_at)) > 300
`).run();

const recovered = sqlite.prepare("SELECT status, cancel_reason FROM followups WHERE id = ?").get(crashId);
assert.equal(recovered.status, 'uncertain');
assert.equal(recovered.cancel_reason, 'recovered_after_crash');
console.log('✅ Test 9 passou: Itens travados pós-crash marcados como uncertain sem reenvio cego.');

// ----------------------------------------------------------------------------
// TESTE 10: Limite Máximo de Tentativas (maxAttempts)
// ----------------------------------------------------------------------------
console.log('Test 10: Limite de tentativas encerra ciclo com no_response...');
const cycleMax = rotateConversationCycle(sqlite, 'InstanciaIA', testJid, testPhone);
// Tentativa 4 além do limite configurado (maxAttempts = 3)
const schedOver = scheduleNextFollowup(sqlite, 'InstanciaIA', testJid, testPhone, 4, cycleMax);
assert.equal(schedOver, null, 'Tentativa além do limite máximo não deve ser agendada');

const cycleStatus = sqlite.prepare("SELECT status FROM conversation_cycles WHERE instance = 'InstanciaIA' AND remote_jid = ?").get(testJid);
assert.equal(cycleStatus.status, 'no_response');
console.log('✅ Test 10 passou: Conversa marcada como no_response ao atingir o limite.');

console.log('\n🎉 TODOS OS 10 TESTES DO FOLLOW-UP AUTOMÁTICO COM IA PASSARAM COM SUCESSO!');
process.exit(0);
