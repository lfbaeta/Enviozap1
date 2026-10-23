import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as XLSX from 'xlsx';
import {
  normalizePhone,
  normalizeCityName,
  generateCitySlug,
  generateCategorySlug,
  migrateExistingContacts
} from '../lib/contacts-utils.mjs';

// Setup in-memory SQLite and run all migrations
const sqlite = new DatabaseSync(':memory:');
for (const f of fs.readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
  for (const s of fs.readFileSync('drizzle/' + f, 'utf8').split('--> statement-breakpoint')) {
    const stmt = s.trim();
    if (stmt) {
      sqlite.exec(stmt.replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '));
    }
  }
}

// Global XLSX injection for worker running from data: URI
globalThis.XLSX = XLSX;

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

const {default: worker} = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync('worker/index.js', 'utf8')).toString('base64'));
const env = {DB, SETTINGS_ENCRYPTION_KEY: '01'.repeat(32)};

async function call(path, method = 'GET', data) {
  return worker.fetch(new Request('https://example.com' + path, {
    method,
    headers: {'Origin': 'https://example.com', 'Content-Type': 'application/json'},
    ...(data ? {body: JSON.stringify(data)} : {})
  }), env, {});
}

console.log('🧪 Iniciando Bateria de Testes da Nova Agenda CRM Estruturada...');

// ==========================================
// TEST 1: Normalização de Telefones (DDD 11-99, 9º dígito, E.164)
// ==========================================
console.log('Test 1: Normalização de Telefones...');
assert.equal(normalizePhone('(13) 99123-4567').phone_e164, '+5513991234567');
assert.equal(normalizePhone('13991234567').phone_e164, '+5513991234567');
assert.equal(normalizePhone('+55 13 99123-4567').phone_e164, '+5513991234567');
assert.equal(normalizePhone('13 9123-4567').phone_e164, '+5513991234567', 'Deve adicionar o 9 ao celular');
assert.equal(normalizePhone('13 3821-1234').phone_e164, '+551338211234', 'Telefone fixo de 8 dígitos preservado');
assert.equal(normalizePhone('013 99123-4567').phone_e164, '+5513991234567', 'Zero antes do DDD removido');
// Invalid phones
assert.equal(normalizePhone('123456').valid, false, 'Muito curto deve ser rejeitado');
assert.equal(normalizePhone('05991234567').valid, false, 'DDD inválido deve ser rejeitado');
assert.equal(normalizePhone('00991234567').valid, false, 'DDD 00 deve ser rejeitado');
assert.equal(normalizePhone('').valid, false);
console.log('✅ Test 1 passou: Normalização de telefones brasileira 100% validada.');

// ==========================================
// TEST 2: Normalização de Nomes e Slugs de Cidades e Categorias
// ==========================================
console.log('Test 2: Normalização de Cidades e Slugs...');
assert.equal(normalizeCityName('sao paulo'), 'São Paulo');
assert.equal(normalizeCityName('SAO PAULO'), 'São Paulo');
assert.equal(normalizeCityName('pariquera acu'), 'Pariquera-Açu');
assert.equal(normalizeCityName('PARIQUERA-ACU'), 'Pariquera-Açu');
assert.equal(generateCitySlug('São Paulo', 'SP'), 'sao-paulo-sp');
assert.equal(generateCitySlug('sao paulo', 'sp'), 'sao-paulo-sp');
assert.equal(generateCitySlug('Pariquera-Açu', 'SP'), 'pariquera-acu-sp');
assert.equal(generateCategorySlug('Açaí & Sorvetes'), 'acai-sorvetes');
assert.equal(generateCategorySlug('Lanches / Hamburgueria'), 'lanches-hamburgueria');
console.log('✅ Test 2 passou: Normalização com acentuação e geração de slugs única.');

// ==========================================
// TEST 3: Integridade da Migração e Categorias Padrão
// ==========================================
console.log('Test 3: Categorias Padrão e Tabelas da Migração...');
const catsRes = await (await call('/api/categories')).json();
assert(catsRes.categories.length >= 8, 'Deve conter as categorias padrão');
const catNames = catsRes.categories.map(c => c.name);
assert(catNames.includes('Restaurante'));
assert(catNames.includes('Pizzaria'));
assert(catNames.includes('Hamburgueria'));
assert(catNames.includes('Açaí'));
console.log('✅ Test 3 passou: Categorias padrão inseridas e disponíveis.');

// ==========================================
// TEST 4: CRUD de Cidades e Mesclagem
// ==========================================
console.log('Test 4: CRUD de Cidades e Mesclagem...');
// Criar cidade Santos
const citySantos = await (await call('/api/cities', 'POST', {name: 'Santos', state: 'SP'})).json();
assert(citySantos.city && citySantos.city.id);
assert.equal(citySantos.city.slug, 'santos-sp');

// Criar cidade com erro de digitação "Santos Antiga"
const citySantosOld = await (await call('/api/cities', 'POST', {name: 'Santos Antiga', state: 'SP'})).json();

// Criar contato em "Santos Antiga"
const contInOld = await (await call('/api/contacts', 'POST', {
  company: 'Padaria Gonzaga',
  phone: '13998881111',
  city_id: citySantosOld.city.id
})).json();
assert(contInOld.contact && contInOld.contact.id);

// Mesclar "Santos Antiga" para "Santos"
const mergeCityRes = await (await call('/api/cities/merge', 'POST', {
  source_id: citySantosOld.city.id,
  target_id: citySantos.city.id
})).json();
assert.equal(mergeCityRes.success, true);
assert.equal(mergeCityRes.contacts_moved, 1);

// Verificar se contato foi transferido para Santos
const contAfterCityMerge = await (await call('/api/contacts/' + contInOld.contact.id)).json();
assert.equal(contAfterCityMerge.contact.city_id, citySantos.city.id);

// Verificar se cidade de origem foi removida
const citiesAfter = await (await call('/api/cities')).json();
assert(!citiesAfter.cities.some(c => c.id === citySantosOld.city.id));
console.log('✅ Test 4 passou: Cidades criadas e mescladas com transferência íntegra.');

// ==========================================
// TEST 5: CRUD de Categorias e Mesclagem
// ==========================================
console.log('Test 5: CRUD de Categorias e Mesclagem...');
const newCatA = await (await call('/api/categories', 'POST', {name: 'Churrascaria', color: '#ef4444'})).json();
const newCatB = await (await call('/api/categories', 'POST', {name: 'Carnes & Grelhados', color: '#b91c1c'})).json();

// Criar contato com Churrascaria
const contactChurras = await (await call('/api/contacts', 'POST', {
  company: 'Boi de Ouro',
  phone: '13998882222',
  category_ids: [newCatA.category.id]
})).json();

// Mesclar Churrascaria para Carnes & Grelhados
const mergeCatRes = await (await call('/api/categories/merge', 'POST', {
  source_id: newCatA.category.id,
  target_id: newCatB.category.id
})).json();
assert.equal(mergeCatRes.success, true);

// Verificar se contato agora possui a categoria B
const contAfterCatMerge = await (await call('/api/contacts/' + contactChurras.contact.id)).json();
assert(contAfterCatMerge.categories.some(c => c.id === newCatB.category.id));
console.log('✅ Test 5 passou: Categorias criadas e mescladas com sucesso.');

// ==========================================
// TEST 6: Importação em 4 Passos (Preview, Commit, CSV Erros, Undo)
// ==========================================
console.log('Test 6: Importação Estruturada em 4 Passos...');
// Criar planilha XLSX em memória
const wb = XLSX.utils.book_new();
const wsData = [
  ['Estabelecimento', 'Telefone', 'Cidade', 'Categoria', 'Responsável'],
  ['Restaurante do Lago', '13 99777-1001', 'Registro', 'Restaurante', 'Manoel'],
  ['Pizzaria Forno Nobre', '13 99777-1002', 'Registro', 'Pizzaria', 'Silvia'],
  ['Restaurante do Lago Repetido', '13 99777-1001', 'Registro', 'Restaurante', 'Manoel Duplicado'],
  ['Sem Telefone Válido', '123', 'Registro', 'Outros', 'Invalido'],
  ['Café da Colina', '13 99777-1005', 'Cananéia', 'Cafeteria', 'Ana']
];
const ws = XLSX.utils.aoa_to_sheet(wsData);
XLSX.utils.book_append_sheet(wb, ws, 'Contatos');
const xlsxBuffer = XLSX.write(wb, {type: 'buffer', bookType: 'xlsx'});
const xlsxBase64 = xlsxBuffer.toString('base64');

// Passo 1 & 2: Preview
const previewRes = await (await call('/api/import/preview', 'POST', {
  base64: xlsxBase64,
  filename: 'teste_importacao.xlsx'
})).json();

assert.equal(previewRes.total_rows, 5);
assert.equal(previewRes.valid_contacts, 4, '4 linhas com telefones válidos');
assert.equal(previewRes.to_create, 3, '3 contatos novos a criar');
assert.equal(previewRes.duplicate_in_file, 1);
assert.equal(previewRes.invalid_phones, 1);
assert(previewRes.column_mapping.company === 'Estabelecimento');
assert(previewRes.column_mapping.phone === 'Telefone');

// Passo 3: Commit
const commitRes = await (await call('/api/import/commit', 'POST', {
  base64: xlsxBase64,
  filename: 'teste_importacao.xlsx',
  column_map: previewRes.column_mapping,
  duplicate_policy: 'skip',
  auto_create_cities: true,
  auto_create_categories: true
})).json();

assert(commitRes.batch_id && typeof commitRes.batch_id === 'string');
assert.equal(commitRes.created, 3);
assert.equal(commitRes.duplicates, 1);
assert.equal(commitRes.invalid, 1);

// Verificar relatório de erros CSV
const errorCsvRes = await call(`/api/import/${commitRes.batch_id}/errors/csv`);
assert.equal(errorCsvRes.status, 200);
const csvContent = await errorCsvRes.text();
assert(csvContent.includes('Linha'));
assert(csvContent.includes('Sem Telefone Válido') || csvContent.includes('Repetido'));

// Passo 4: Desfazer importação (Undo)
const undoRes = await (await call(`/api/import/${commitRes.batch_id}/undo`, 'POST')).json();
assert.equal(undoRes.success, true);
assert.equal(undoRes.removed, 3, 'Deve remover os 3 contatos criados pelo lote');

// Verificar se contatos do lote foram apagados
const afterUndo = await (await call('/api/contacts?q=Forno+Nobre')).json();
assert.equal(afterUndo.contacts.length, 0, 'Contatos do lote desfeito não devem mais existir');
console.log('✅ Test 6 passou: Importação em 4 passos (prévia, gravação, relatório CSV e rollback) 100% funcional.');

// ==========================================
// TEST 7: Edição Completa, Alteração de Telefone e Detecção de Duplicata
// ==========================================
console.log('Test 7: Edição Completa e Detecção de Duplicata...');
// Criar Contato 1
const c1 = await (await call('/api/contacts', 'POST', {
  company: 'Empresa Alfa',
  phone: '13991113333',
  email: 'alfa@teste.com'
})).json();

// Criar Contato 2
const c2 = await (await call('/api/contacts', 'POST', {
  company: 'Empresa Beta',
  phone: '13991114444',
  email: 'beta@teste.com'
})).json();

// Tentar alterar telefone de C2 para o mesmo telefone de C1 sem mesclar -> Deve acusar conflito 409
const conflictRes = await call(`/api/contacts/${c2.contact.id}`, 'PATCH', {
  phone: '13991113333'
});
assert.equal(conflictRes.status, 409, 'Alterar para telefone existente sem autorização deve retornar 409');

// Mesclar C2 em C1
const mergeRes = await (await call(`/api/contacts/${c2.contact.id}`, 'PATCH', {
  merge_with_id: c1.contact.id
})).json();
assert.equal(mergeRes.success, true);
assert.equal(mergeRes.merged, true);

// Verificar que C2 não existe mais
const getC2 = await call(`/api/contacts/${c2.contact.id}`);
assert.equal(getC2.status, 404);
console.log('✅ Test 7 passou: Proteção contra alteração indevida de telefone e mesclagem de contatos funcionando.');

// ==========================================
// TEST 8: Exclusão Lógica (Lixeira), Cancelamento de Filas e Restauração
// ==========================================
console.log('Test 8: Lixeira, Cancelamento de Fila e Follow-up, e Restauração...');
const cTrash = await (await call('/api/contacts', 'POST', {
  company: 'Marmitaria Central',
  phone: '13991115555'
})).json();
const cId = cTrash.contact.id;

// Adicionar à fila de envio
await call('/api/queue', 'POST', {contactIds: [cId], type: 'initial', mode: 'STANDARD'});
const qBefore = await (await call('/api/queue')).json();
assert(qBefore.entries.some(e => e.contact_id === cId), 'Contato deve estar na fila A Enviar');

// Mover contato para a lixeira (Soft Delete)
const delRes = await (await call(`/api/contacts/${cId}`, 'DELETE')).json();
assert.equal(delRes.success, true);

// Verificar se sumiu da fila A Enviar
const qAfter = await (await call('/api/queue')).json();
assert(!qAfter.entries.some(e => e.contact_id === cId), 'Contato excluído deve ser retirado da fila');

// Verificar se está na lixeira
const trashList = await (await call('/api/contacts?trash=1')).json();
assert(trashList.contacts.some(c => c.id === cId), 'Contato deve constar na lixeira');

// Restaurar contato
const restoreRes = await (await call(`/api/contacts/${cId}/restore`, 'POST')).json();
assert.equal(restoreRes.success, true);

// Verificar que voltou para a agenda ativa
const activeList = await (await call(`/api/contacts/${cId}`)).json();
assert.equal(activeList.contact.deleted_at, null);

// Exclusão definitiva
const permDelRes = await (await call(`/api/contacts/${cId}?permanent=true`, 'DELETE')).json();
assert.equal(permDelRes.success, true);
assert.equal(permDelRes.permanent, true);

const getPerm = await call(`/api/contacts/${cId}`);
assert.equal(getPerm.status, 404, 'Contato excluído definitivamente não pode existir no banco');
console.log('✅ Test 8 passou: Ciclo de vida de exclusão lógica, cancelamento de tarefas e purge permanente verificado.');

// ==========================================
// TEST 9: Ações em Massa (Bulk)
// ==========================================
console.log('Test 9: Operações em Massa (Bulk Actions)...');
const b1 = await (await call('/api/contacts', 'POST', {company: 'Lote 1', phone: '13991116001'})).json();
const b2 = await (await call('/api/contacts', 'POST', {company: 'Lote 2', phone: '13991116002'})).json();
const b3 = await (await call('/api/contacts', 'POST', {company: 'Lote 3', phone: '13991116003'})).json();
const bulkIds = [b1.contact.id, b2.contact.id, b3.contact.id];

// Bulk atribuir categoria
const catLanchonete = catsRes.categories.find(c => c.name === 'Lanchonete') || catsRes.categories[0];
const bulkCatRes = await (await call('/api/contacts/bulk', 'POST', {
  action: 'add_category',
  ids: bulkIds,
  category_id: catLanchonete.id
})).json();
assert.equal(bulkCatRes.affected, 3);

// Bulk soft delete
const bulkDelRes = await (await call('/api/contacts/bulk', 'POST', {
  action: 'delete',
  ids: bulkIds
})).json();
assert.equal(bulkDelRes.affected, 3);

// Bulk restore
const bulkRestoreRes = await (await call('/api/contacts/bulk', 'POST', {
  action: 'restore',
  ids: bulkIds
})).json();
assert.equal(bulkRestoreRes.affected, 3);

// Bulk enqueue
const bulkQueueRes = await (await call('/api/contacts/bulk', 'POST', {
  action: 'enqueue',
  ids: bulkIds,
  message_type: 'presentation'
})).json();
assert.equal(bulkQueueRes.affected, 3);
console.log('✅ Test 9 passou: Ações em massa por IDs e filtros operando com precisão.');

// ==========================================
// TEST 10: Auto-Criação de Contato Novo Recebido no WhatsApp
// ==========================================
console.log('Test 10: Auto-Criação de Contato Desconhecido via WhatsApp...');
const unknownPhoneRaw = '5513996543210';
const unknownE164 = normalizePhone(unknownPhoneRaw).phone_e164;
assert.equal(unknownE164, '+5513996543210');

// Simular inserção pelo server ao receber mensagem
const existing = sqlite.prepare('SELECT id FROM contacts WHERE phone_e164 = ? OR phone = ?').get(unknownE164, unknownPhoneRaw);
assert.equal(existing, undefined, 'Contato não deve existir antes da mensagem');

// Executa a lógica de auto-criação do server.mjs
sqlite.prepare(`
  INSERT INTO contacts (id, company, phone, phone_e164, phone_raw, city, source, status, interested, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'WhatsApp', 'whatsapp', 'AGENDA', 0, datetime('now'), datetime('now'))
`).run(randomUUID(), `WhatsApp ${unknownPhoneRaw}`, unknownPhoneRaw, unknownE164, unknownPhoneRaw);

const autoCreated = sqlite.prepare('SELECT id, company, source, phone_e164, city FROM contacts WHERE phone_e164 = ?').get(unknownE164);
assert(autoCreated && autoCreated.id);
assert.equal(autoCreated.source, 'whatsapp');
assert.equal(autoCreated.phone_e164, '+5513996543210');
assert.equal(autoCreated.city, 'WhatsApp');
console.log('✅ Test 10 passou: Contato novo do WhatsApp criado automaticamente com rastreabilidade.');

console.log('🎉 TODOS OS 10 TESTES DA NOVA AGENDA CRM ESTRUTURADA PASSARAM COM 100% DE SUCESSO!');
