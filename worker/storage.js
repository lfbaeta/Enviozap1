function database(env){if(!env.DB)throw new Error('DB_UNAVAILABLE');return env.DB}
function statement(env,sql,...values){return database(env).prepare(sql).bind(...values)}
async function savedSettings(env){return statement(env,'SELECT config_json,key_cipher FROM settings WHERE id = ?',1).first()}
async function encryptionKey(env){if(!env.SETTINGS_ENCRYPTION_KEY)throw new Error('KEY_CONFIG_UNAVAILABLE');return crypto.subtle.importKey('raw',Uint8Array.from(env.SETTINGS_ENCRYPTION_KEY.match(/.{2}/g).map(v=>parseInt(v,16))),{name:'AES-GCM'},false,['encrypt','decrypt'])}
function base64(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes)))}
function fromBase64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function encryptSecret(secret,env){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(env),new TextEncoder().encode(secret));return base64(iv)+'.'+base64(data)}
async function decryptSecret(cipher,env){const [iv,data]=cipher.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},await encryptionKey(env),fromBase64(data)))}
async function configuredApiKey(env){const row=await savedSettings(env);return row?.key_cipher?decryptSecret(row.key_cipher,env):env.GEMINI_API_KEY||''}
const TEMPLATE_KEYS=['initial','presentation','promotion','followup','trial'];
function validConfig(config){return config&&typeof config.aiEnabled==='boolean'&&typeof config.aiInstructions==='string'&&config.aiInstructions.length<=8000&&typeof config.aiRegistration==='string'&&config.aiRegistration.length<=4000&&typeof config.aiHandoff==='string'&&config.aiHandoff.length<=3000&&(config.aiGreetingPrompt===undefined||typeof config.aiGreetingPrompt==='string')&&(config.aiPrompt===undefined||typeof config.aiPrompt==='string')&&(config.aiModel===undefined||typeof config.aiModel==='string')&&(config.aiMinDelay===undefined||typeof config.aiMinDelay==='number')&&(config.aiMaxDelay===undefined||typeof config.aiMaxDelay==='number')&&(config.aiInstanceId===undefined||typeof config.aiInstanceId==='string'||config.aiInstanceId===null)&&(config.disparoInstanceId===undefined||typeof config.disparoInstanceId==='string'||config.disparoInstanceId===null)&&(config.aiSmartTiming===undefined||typeof config.aiSmartTiming==='boolean')&&(config.aiHumanDetection===undefined||typeof config.aiHumanDetection==='boolean')&&(config.aiHumanPauseMinutes===undefined||typeof config.aiHumanPauseMinutes==='number')&&(config.aiSendPresence===undefined||typeof config.aiSendPresence==='boolean')&&(config.aiTemperature===undefined||typeof config.aiTemperature==='number')&&(config.aiMaxChars===undefined||typeof config.aiMaxChars==='number')&&(config.aiStrictControl===undefined||typeof config.aiStrictControl==='boolean')&&typeof config.offer==='string'&&config.offer.trim()&&config.offer.length<=4000&&typeof config.tone==='string'&&config.tone.length<=100&&typeof config.length==='string'&&config.length.length<=50&&typeof config.emojis==='boolean'&&TEMPLATE_KEYS.every(k=>typeof config.templates?.[k]==='string'&&config.templates[k].length<=10000)}
async function requestData(request,max=15000000){const raw=await request.text();if(raw.length>max)throw new Error('INPUT_TOO_LARGE');return JSON.parse(raw)}

// ============================================================================
// NORMALIZAÇÃO DE TELEFONE E UTILITÁRIOS DA AGENDA ESTRUTURADA
// ============================================================================
const VALID_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, // SP
  21, 22, 24,                         // RJ
  27, 28,                             // ES
  31, 32, 33, 34, 35, 37, 38,         // MG
  41, 42, 43, 44, 45, 46,             // PR
  47, 48, 49,                         // SC
  51, 53, 54, 55,                     // RS
  61, 62, 64,                         // DF/GO
  63,                                 // TO
  65, 66,                             // MT
  67,                                 // MS
  68,                                 // AC
  69,                                 // RO
  71, 73, 74, 75, 77,                 // BA
  79,                                 // SE
  81, 87,                             // PE
  82,                                 // AL
  83,                                 // PB
  84,                                 // RN
  85, 88,                             // CE
  86, 89,                             // PI
  91, 93, 94,                         // PA
  92, 97,                             // AM
  95,                                 // RR
  96,                                 // AP
  98, 99                              // MA
]);

function normalizePhone(raw) {
  if (raw === null || raw === undefined) {
    return { valid: false, reason: 'Telefone não informado' };
  }
  let str = String(raw).trim();
  let digits = str.replace(/\D/g, '');
  if (!digits) {
    return { valid: false, reason: 'Nenhum dígito encontrado' };
  }

  // Remove zeros à esquerda (ex: 011988887777 ou 005511...)
  digits = digits.replace(/^0+/, '');

  let ddd = '';
  let number = '';

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    ddd = digits.slice(2, 4);
    number = digits.slice(4);
  } else if (digits.length === 10 || digits.length === 11) {
    ddd = digits.slice(0, 2);
    number = digits.slice(2);
  } else if (digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    return { valid: false, reason: 'Telefone com formato ambíguo (faltando DDD ou número incompleto)' };
  } else if (digits.length < 10) {
    return { valid: false, reason: 'Telefone incompleto (faltam DDD e dígitos)' };
  } else if (digits.length > 13) {
    return { valid: false, reason: 'Telefone com excesso de dígitos' };
  } else {
    return { valid: false, reason: 'Formato de telefone não reconhecido' };
  }

  const dddNum = parseInt(ddd, 10);
  if (!VALID_DDDS.has(dddNum)) {
    return { valid: false, reason: `DDD "${ddd}" não é um DDD brasileiro válido` };
  }

  if (/^(\d)\1+$/.test(number)) {
    return { valid: false, reason: 'Número inválido (todos os dígitos repetidos)' };
  }

  let isMobile = false;
  if (number.length === 8) {
    const firstDigit = number[0];
    if (['6', '7', '8', '9'].includes(firstDigit)) {
      number = '9' + number;
      isMobile = true;
    } else {
      isMobile = false;
    }
  } else if (number.length === 9) {
    if (number.startsWith('9')) {
      isMobile = true;
    } else {
      return { valid: false, reason: 'Número de 9 dígitos deve iniciar com 9 para celular' };
    }
  } else {
    return { valid: false, reason: 'Número local deve ter 8 ou 9 dígitos' };
  }

  const phone_digits = '55' + ddd + number;
  const phone_e164 = '+55' + ddd + number;

  return {
    valid: true,
    phone_e164,
    phone_digits,
    ddd,
    number,
    is_mobile: isMobile
  };
}

function cleanPhone(v) {
  const norm = normalizePhone(v);
  if (norm.valid) return norm.phone_digits;
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

function cleanText(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

function normalizeCityName(rawName) {
  if (!rawName) return '';
  let str = String(rawName).trim();
  return str.split(/\s+/).map(w => {
    if (!w) return '';
    const lower = w.toLowerCase();
    if (['de', 'da', 'do', 'dos', 'das', 'e'].includes(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function generateCitySlug(name, state = '') {
  const normName = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normState = String(state || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  if (normState) {
    return `${normName}-${normState}`;
  }
  return normName;
}

function generateCategorySlug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return [];
  const firstLine = lines[0];
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  let delimiter = ',';
  if (semiCount > commaCount && semiCount >= tabCount) delimiter = ';';
  else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

  function splitLine(line) {
    const row = [];
    let insideQuote = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuote && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === delimiter && !insideQuote) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    return row;
  }

  const headers = splitLine(lines[0]).map(h => h.replace(/^["']|["']$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] || '').replace(/^["']|["']$/g, '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

function parseSpreadsheetBuffer(fileBase64, filename = '') {
  const isCsv = filename.toLowerCase().endsWith('.csv');
  const XLSX = globalThis.XLSX;
  if (XLSX && !isCsv) {
    try {
      const buf = Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0));
      const workbook = XLSX.read(buf, { type: 'array', cellFormula: false, cellHTML: false });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    } catch (e) {
      console.warn('[XLSX Parse Warning]', e.message);
    }
  }
  const text = new TextDecoder('utf-8').decode(Uint8Array.from(atob(fileBase64), c => c.charCodeAt(0)));
  return parseCSV(text);
}

function detectColumnMapping(headers) {
  const mapping = {
    company: '',
    phone: '',
    responsible: '',
    city: '',
    state: '',
    category: '',
    email: '',
    instagram: '',
    address: '',
    notes: ''
  };

  const clean = str => str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  for (const h of headers) {
    const c = clean(h);
    if (!mapping.company && (c.includes('empresa') || c.includes('estabelecimento') || c.includes('nome') || c.includes('razao') || c.includes('fantasia') || c.includes('loja'))) {
      mapping.company = h;
    } else if (!mapping.phone && (c.includes('whats') || c.includes('telefone') || c.includes('celular') || c.includes('phone') || c.includes('tel') || c.includes('contato') || c.includes('fone'))) {
      mapping.phone = h;
    } else if (!mapping.responsible && (c.includes('responsavel') || c.includes('dono') || c.includes('proprietario') || c.includes('gerente'))) {
      mapping.responsible = h;
    } else if (!mapping.city && (c.includes('cidade') || c.includes('municipio') || c.includes('city'))) {
      mapping.city = h;
    } else if (!mapping.state && (c === 'uf' || c === 'estado' || c === 'state')) {
      mapping.state = h;
    } else if (!mapping.category && (c.includes('categoria') || c.includes('segmento') || c.includes('nicho') || c.includes('ramo') || c.includes('category'))) {
      mapping.category = h;
    } else if (!mapping.email && (c.includes('email') || c.includes('e-mail') || c.includes('mail'))) {
      mapping.email = h;
    } else if (!mapping.instagram && (c.includes('instagram') || c.includes('insta') || c.includes('ig'))) {
      mapping.instagram = h;
    } else if (!mapping.address && (c.includes('endereco') || c.includes('endereço') || c.includes('rua') || c.includes('bairro') || c.includes('localizacao'))) {
      mapping.address = h;
    } else if (!mapping.notes && (c.includes('observacao') || c.includes('obs') || c.includes('nota') || c.includes('detalhe') || c.includes('info'))) {
      mapping.notes = h;
    }
  }
  return mapping;
}

function parseSpintax(text){let prev;do{prev=text;text=text.replace(/\{([^{}]+)\}/g,(m,c)=>c.includes('|')?c.split('|')[Math.floor(Math.random()*c.split('|').length)]:m)}while(text!==prev);return text}
async function event(env,contactId,name,details=''){await statement(env,'INSERT INTO contact_events(id,contact_id,event,details,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),contactId,name,details,new Date().toISOString()).run()}

function generateSmartDelivaleReply(userText,history=[],systemPrompt='',cfg={},companyName='Restaurante'){
  const text=(userText||'').toLowerCase().trim();
  const company=companyName||'seu estabelecimento';
  const offer=cfg.offer||'Cardápio digital próprio para delivery com 30 dias grátis de teste, sem taxa de montagem e com integração no WhatsApp.';
  const registration=cfg.aiRegistration||'Nome do responsável, nome do estabelecimento, cidade e WhatsApp';
  const handoff=cfg.aiHandoff||'Perfeito! 😊 Seus dados foram anotados e nossa equipe entrará em contato para liberar seu acesso e montar sua demonstração.';

  if(/\b\d{8,12}\b/.test(text.replace(/\D/g,''))||text.includes('nome:')||text.includes('responsável:')||(text.includes('meu nome')&&(text.includes('rua')||text.includes('whats')||text.includes('telefone')))){
    return `${handoff}\n\nFicou alguma dúvida sobre como você vai receber os pedidos ou como funciona o painel?`;
  }
  if(text.includes('humano')||text.includes('atendente')||text.includes('pessoa real')||text.includes('falar com alguém')){
    return `Com certeza! Já avisei nossa equipe de atendimento da Delivale e um atendente humano irá assumir esta conversa em instantes para te ajudar. Pode me adiantar qual seria a sua dúvida principal?`;
  }
  if(text.includes('quero testar')||text.includes('como faço pra cadastrar')||text.includes('quero cadastrar')||text.includes('tenho interesse')||text.includes('como começo')||text.includes('pode montar')||text.includes('quero conhecer')||text.includes('sim, quero')||text.includes('vamos testar')||text.includes('pode ser')){
    return `Excelente decisão! 🎉 O teste é 100% gratuito por 30 dias e nós mesmos deixamos o cardápio digital do ${company} montado e pronto para você conhecer na prática.\n\nPara iniciarmos a liberação, por favor me informe:\n- ${registration.split(';').join('\n- ')}\n\nAssim que me enviar, nossa equipe já começa a montagem!`;
  }
  if(text.includes('quanto custa')||text.includes('qual o valor')||text.includes('mensalidade')||text.includes('preço')||text.includes('preco')||text.includes('taxa')||text.includes('comissão')||text.includes('porcentagem')||text.includes('gratis')||text.includes('grátis')){
    return `Olá! Na Delivale você tem **30 dias de teste 100% gratuitos** para o ${company}, sem taxa de montagem da loja e sem surpresas. Além disso, **não cobramos comissão por pedido**, diferente de outros aplicativos que chegam a reter até 27% das suas vendas!\n\nVocê gostaria de ver uma demonstração de como ficaria o cardápio digital do seu estabelecimento pelo celular?`;
  }
  if(text.includes('como funciona')||text.includes('o que é')||text.includes('oque é')||text.includes('me explica')||text.includes('como é')){
    return `A Delivale funciona de forma muito prática: nós montamos o seu cardápio digital interativo com produtos, fotos, categorias e preços. O cliente acessa pelo link no WhatsApp ou Instagram, escolhe os itens e o pedido chega completo no seu WhatsApp com endereço, forma de pagamento e total!\n\nConta também com impressão automática e participação no marketplace da cidade. O ${company} já trabalha com pedidos pelo WhatsApp hoje?`;
  }
  if(text.includes('já tenho')||text.includes('ja tenho')||text.includes('ifood')||text.includes('cardapio')||text.includes('cardápio')){
    return `Que bom que você já tem estrutura! A Delivale é o complemento ideal: ela não substitui os clientes que já chegam pelo iFood, mas impede que você pague comissões abusivas para os clientes fiéis da sua cidade. Você direciona seu WhatsApp/Instagram para a Delivale com **0% de comissão** e economiza todo mês!\n\nPodemos liberar o teste de 30 dias sem custo para você comparar na prática?`;
  }
  if(text.startsWith('oi')||text.startsWith('olá')||text.startsWith('ola')||text.startsWith('bom dia')||text.startsWith('boa tarde')||text.startsWith('boa noite')||text==='opa'){
    const customGreeting = (cfg.aiGreetingPrompt || '').trim();
    if(customGreeting){
      let saudacaoPeriodo = text.includes('bom dia') ? 'Bom dia' : (text.includes('boa tarde') ? 'Boa tarde' : (text.includes('boa noite') ? 'Boa noite' : 'Tudo bem?'));
      return customGreeting
        .replaceAll('{saudacao}', saudacaoPeriodo)
        .replaceAll('{empresa}', company)
        .replaceAll('{cidade}', 'sua cidade')
        .replaceAll('{oferta}', cfg.offer || '');
    }
    return `Olá! Tudo bem? Prazer em falar com você! Sou a assistente virtual da Delivale.com. Vi o ${company} e queria saber: vocês já utilizam um cardápio digital próprio para facilitar o atendimento aos clientes no WhatsApp?`;
  }
  return `Com certeza! Na Delivale nosso objetivo é facilitar o atendimento do ${company} e aumentar suas vendas no delivery com cardápio digital próprio e 30 dias de teste gratuito.\n\nGostaria de ver uma demonstração preparada para o seu estabelecimento?`;
}

// ============================================================================
// STORAGE HANDLER CENTRAL
// ============================================================================
async function handleStorage(request,env,url){
  const central = url.pathname.startsWith('/api/contacts') ||
                  url.pathname.startsWith('/api/cities') ||
                  url.pathname.startsWith('/api/categories') ||
                  url.pathname.startsWith('/api/import') ||
                  url.pathname.startsWith('/api/queue') ||
                  url.pathname === '/api/dashboard' ||
                  url.pathname === '/api/send-rules' ||
                  url.pathname.startsWith('/api/instances') ||
                  url.pathname === '/api/ai/test' ||
                  url.pathname === '/api/gemini/test' ||
                  url.pathname.startsWith('/api/followup');

  if(!central && !['/api/settings','/api/settings/key','/api/history'].includes(url.pathname) && !url.pathname.startsWith('/api/history/')) return null;

  if(request.method !== 'GET' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin){
    try{
      const oHost = new URL(request.headers.get('Origin')).host, uHost = new URL(url.origin).host;
      if(oHost !== uHost && !oHost.endsWith('.run.app') && !oHost.includes('localhost')) return json({error:'Origem não autorizada.'}, 403);
    }catch{ return json({error:'Origem não autorizada.'}, 403); }
  }

  try{
    // ========================================================================
    // DASHBOARD METRICS
    // ========================================================================
    if(url.pathname === '/api/dashboard' && request.method === 'GET'){
      const [agenda, queued, sent, interested, errors, citiesCount, categoriesCount, trashCount] = await Promise.all([
        statement(env, "SELECT COUNT(*) n FROM contacts WHERE status='AGENDA' AND deleted_at IS NULL").first(),
        statement(env, "SELECT COUNT(*) n FROM send_queue WHERE status IN ('QUEUED','PROCESSING')").first(),
        statement(env, "SELECT COUNT(*) n FROM contacts WHERE (status='SENT' OR status='INTERESTED') AND deleted_at IS NULL").first(),
        statement(env, "SELECT COUNT(*) n FROM contacts WHERE interested=1 AND deleted_at IS NULL").first(),
        statement(env, "SELECT COUNT(*) n FROM send_queue WHERE status='ERROR'").first(),
        statement(env, "SELECT COUNT(*) n FROM cities").first().catch(() => ({ n: 0 })),
        statement(env, "SELECT COUNT(*) n FROM categories").first().catch(() => ({ n: 0 })),
        statement(env, "SELECT COUNT(*) n FROM contacts WHERE deleted_at IS NOT NULL").first().catch(() => ({ n: 0 }))
      ]);
      return json({
        agenda: agenda?.n || 0,
        queued: queued?.n || 0,
        sent: sent?.n || 0,
        interested: interested?.n || 0,
        errors: errors?.n || 0,
        cities: citiesCount?.n || 0,
        categories: categoriesCount?.n || 0,
        trash: trashCount?.n || 0
      });
    }

    // ========================================================================
    // CIDADES (CRUD + MERGE)
    // ========================================================================
    if(url.pathname === '/api/cities' && request.method === 'GET'){
      const rows = (await statement(env, `
        SELECT c.*,
          (SELECT COUNT(*) FROM contacts k WHERE k.city_id = c.id AND k.deleted_at IS NULL) as contacts_count
        FROM cities c
        ORDER BY c.name COLLATE NOCASE
      `).all()).results || [];
      return json({ cities: rows });
    }

    if(url.pathname === '/api/cities' && request.method === 'POST'){
      const d = await requestData(request, 10000);
      const name = normalizeCityName(cleanText(d.name, 120));
      const state = cleanText(d.state, 10).toUpperCase();
      if(!name) return json({ error: 'Nome da cidade é obrigatório.' }, 400);
      const slug = generateCitySlug(name, state);
      const exists = await statement(env, 'SELECT id FROM cities WHERE slug = ?', slug).first();
      if(exists) return json({ error: 'Já existe uma cidade cadastrada com este nome e estado.' }, 409);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await statement(env, 'INSERT INTO cities (id, name, state, slug, created_at) VALUES (?, ?, ?, ?, ?)', id, name, state, slug, now).run();
      return json({ success: true, city: { id, name, state, slug } });
    }

    if(url.pathname.match(/^\/api\/cities\/[^/]+$/) && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const d = await requestData(request, 10000);
      const name = normalizeCityName(cleanText(d.name, 120));
      const state = cleanText(d.state, 10).toUpperCase();
      if(!name) return json({ error: 'Nome da cidade é obrigatório.' }, 400);
      const slug = generateCitySlug(name, state);
      const other = await statement(env, 'SELECT id FROM cities WHERE slug = ? AND id != ?', slug, id).first();
      if(other) return json({ error: 'Outra cidade já utiliza este nome e estado.' }, 409);
      await statement(env, 'UPDATE cities SET name = ?, state = ?, slug = ? WHERE id = ?', name, state, slug, id).run();
      await statement(env, 'UPDATE contacts SET city = ? WHERE city_id = ?', name, id).run();
      return json({ success: true });
    }

    if(url.pathname.match(/^\/api\/cities\/[^/]+$/) && request.method === 'DELETE'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const moveToCityId = url.searchParams.get('moveToCityId');
      const countRow = await statement(env, 'SELECT COUNT(*) as n FROM contacts WHERE city_id = ?', id).first();
      const count = countRow?.n || 0;
      if(count > 0 && !moveToCityId){
        return json({ error: `Esta cidade possui ${count} contato(s) vinculado(s). Escolha uma cidade de destino para transferi-los antes de excluir.` }, 400);
      }
      if(count > 0 && moveToCityId){
        const targetCity = await statement(env, 'SELECT name FROM cities WHERE id = ?', moveToCityId).first();
        if(!targetCity) return json({ error: 'Cidade de destino não encontrada.' }, 404);
        await statement(env, 'UPDATE contacts SET city_id = ?, city = ? WHERE city_id = ?', moveToCityId, targetCity.name, id).run();
      }
      await statement(env, 'DELETE FROM cities WHERE id = ?', id).run();
      return json({ success: true, moved: count });
    }

    if(url.pathname === '/api/cities/merge' && request.method === 'POST'){
      const d = await requestData(request, 10000);
      const sourceCityId = d.sourceCityId || d.source_id;
      const targetCityId = d.targetCityId || d.target_id;
      if(!sourceCityId || !targetCityId || sourceCityId === targetCityId){
        return json({ error: 'Selecione duas cidades distintas para mesclar.' }, 400);
      }
      const targetCity = await statement(env, 'SELECT name FROM cities WHERE id = ?', targetCityId).first();
      if(!targetCity) return json({ error: 'Cidade de destino não encontrada.' }, 404);
      const r = await statement(env, 'UPDATE contacts SET city_id = ?, city = ? WHERE city_id = ?', targetCityId, targetCity.name, sourceCityId).run();
      await statement(env, 'DELETE FROM cities WHERE id = ?', sourceCityId).run();
      const moved = r.meta?.changes !== undefined ? r.meta.changes : 1;
      return json({ success: true, contacts_moved: moved, moved });
    }

    // ========================================================================
    // CATEGORIAS (CRUD + MERGE)
    // ========================================================================
    if(url.pathname === '/api/categories' && request.method === 'GET'){
      const rows = (await statement(env, `
        SELECT c.*,
          (SELECT COUNT(DISTINCT cc.contact_id) FROM contact_categories cc JOIN contacts k ON k.id = cc.contact_id WHERE cc.category_id = c.id AND k.deleted_at IS NULL) as contacts_count
        FROM categories c
        ORDER BY c.name COLLATE NOCASE
      `).all()).results || [];
      return json({ categories: rows });
    }

    if(url.pathname === '/api/categories' && request.method === 'POST'){
      const d = await requestData(request, 10000);
      const name = cleanText(d.name, 100);
      const color = cleanText(d.color || '#64748b', 20);
      const description = cleanText(d.description || '', 500);
      if(!name) return json({ error: 'Nome da categoria é obrigatório.' }, 400);
      const slug = generateCategorySlug(name);
      const exists = await statement(env, 'SELECT id FROM categories WHERE slug = ?', slug).first();
      if(exists) return json({ error: 'Já existe uma categoria cadastrada com este nome.' }, 409);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await statement(env, 'INSERT INTO categories (id, name, slug, color, description, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, slug, color, description, now).run();
      return json({ success: true, category: { id, name, slug, color, description } });
    }

    if(url.pathname.match(/^\/api\/categories\/[^/]+$/) && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const d = await requestData(request, 10000);
      const name = cleanText(d.name, 100);
      const color = cleanText(d.color || '#64748b', 20);
      const description = cleanText(d.description || '', 500);
      if(!name) return json({ error: 'Nome da categoria é obrigatório.' }, 400);
      const slug = generateCategorySlug(name);
      const other = await statement(env, 'SELECT id FROM categories WHERE slug = ? AND id != ?', slug, id).first();
      if(other) return json({ error: 'Outra categoria já utiliza este nome.' }, 409);
      await statement(env, 'UPDATE categories SET name = ?, slug = ?, color = ?, description = ? WHERE id = ?', name, slug, color, description, id).run();
      return json({ success: true });
    }

    if(url.pathname.match(/^\/api\/categories\/[^/]+$/) && request.method === 'DELETE'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const moveToCategoryId = url.searchParams.get('moveToCategoryId');
      const countRow = await statement(env, 'SELECT COUNT(*) as n FROM contact_categories WHERE category_id = ?', id).first();
      const count = countRow?.n || 0;
      if(count > 0 && !moveToCategoryId){
        return json({ error: `Esta categoria possui ${count} contato(s) vinculado(s). Escolha uma categoria de destino para transferi-los.` }, 400);
      }
      if(count > 0 && moveToCategoryId){
        await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) SELECT contact_id, ? FROM contact_categories WHERE category_id = ?', moveToCategoryId, id).run();
        await statement(env, 'DELETE FROM contact_categories WHERE category_id = ?', id).run();
      }
      await statement(env, 'DELETE FROM categories WHERE id = ?', id).run();
      return json({ success: true, moved: count });
    }

    if(url.pathname === '/api/categories/merge' && request.method === 'POST'){
      const d = await requestData(request, 10000);
      const sourceCategoryId = d.sourceCategoryId || d.source_id;
      const targetCategoryId = d.targetCategoryId || d.target_id;
      if(!sourceCategoryId || !targetCategoryId || sourceCategoryId === targetCategoryId){
        return json({ error: 'Selecione duas categorias distintas para mesclar.' }, 400);
      }
      await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) SELECT contact_id, ? FROM contact_categories WHERE category_id = ?', targetCategoryId, sourceCategoryId).run();
      await statement(env, 'DELETE FROM contact_categories WHERE category_id = ?', sourceCategoryId).run();
      await statement(env, 'DELETE FROM categories WHERE id = ?', sourceCategoryId).run();
      return json({ success: true });
    }

    // ========================================================================
    // CONTATOS (AGENDA ROBUSTA)
    // ========================================================================
    if(url.pathname === '/api/contacts' && request.method === 'GET'){
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = (page - 1) * limit;

      const q = cleanText(url.searchParams.get('q') || '', 150);
      const city = cleanText(url.searchParams.get('city') || '', 120);
      const cityId = cleanText(url.searchParams.get('city_id') || '', 60);
      const categoryId = cleanText(url.searchParams.get('category_id') || '', 60);
      const status = cleanText(url.searchParams.get('status') || '', 30);
      const interested = url.searchParams.get('interested');
      const source = cleanText(url.searchParams.get('source') || '', 50);
      const batchId = cleanText(url.searchParams.get('batch_id') || '', 60);
      const noCategory = url.searchParams.get('no_category') === '1' || url.searchParams.get('no_category') === 'true';
      const noCity = url.searchParams.get('no_city') === '1' || url.searchParams.get('no_city') === 'true';
      const isTrash = url.searchParams.get('trash') === '1' || url.searchParams.get('trash') === 'true';

      const sortCol = cleanText(url.searchParams.get('sort') || 'company', 30);
      const orderDir = (url.searchParams.get('order') || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      const validSortCols = {
        company: 'c.company COLLATE NOCASE',
        phone: 'c.phone',
        city: 'COALESCE(ci.name, c.city) COLLATE NOCASE',
        created_at: 'c.created_at',
        last_sent_at: 'c.last_sent_at',
        status: 'c.status'
      };
      const orderBy = validSortCols[sortCol] || 'c.company COLLATE NOCASE';

      let whereClause = isTrash ? 'WHERE c.deleted_at IS NOT NULL' : 'WHERE c.deleted_at IS NULL';
      const args = [];

      if(cityId){
        whereClause += ' AND c.city_id = ?';
        args.push(cityId);
      } else if(city){
        whereClause += ' AND (c.city = ? OR ci.name = ?)';
        args.push(city, city);
      }

      if(status){
        whereClause += ' AND c.status = ?';
        args.push(status);
      }

      if(interested !== null && interested !== undefined && interested !== ''){
        whereClause += ' AND c.interested = ?';
        args.push(Number(interested) ? 1 : 0);
      }

      if(source){
        whereClause += ' AND c.source = ?';
        args.push(source);
      }

      if(batchId){
        whereClause += ' AND c.import_batch_id = ?';
        args.push(batchId);
      }

      if(noCategory){
        whereClause += ' AND NOT EXISTS (SELECT 1 FROM contact_categories cc WHERE cc.contact_id = c.id)';
      } else if(categoryId){
        whereClause += ' AND EXISTS (SELECT 1 FROM contact_categories cc WHERE cc.contact_id = c.id AND cc.category_id = ?)';
        args.push(categoryId);
      }

      if(noCity){
        whereClause += " AND (c.city_id IS NULL OR c.city IS NULL OR c.city = '' OR c.city = 'Geral')";
      }

      if(q){
        whereClause += ' AND (c.company LIKE ? OR c.phone LIKE ? OR c.phone_e164 LIKE ? OR c.responsible LIKE ? OR c.email LIKE ? OR c.notes LIKE ? OR c.address LIKE ?)';
        const queryTerm = '%' + q + '%';
        args.push(queryTerm, queryTerm, queryTerm, queryTerm, queryTerm, queryTerm, queryTerm);
      }

      // Contagem total para paginação
      const countSql = `SELECT COUNT(*) as n FROM contacts c LEFT JOIN cities ci ON ci.id = c.city_id ${whereClause}`;
      const totalRow = await statement(env, countSql, ...args).first();
      const total = totalRow?.n || 0;

      // Busca paginada
      const dataSql = `
        SELECT c.*,
          COALESCE(ci.name, c.city) as city_name,
          COALESCE(ci.state, '') as city_state,
          (SELECT COUNT(*) FROM contacts c2 WHERE c2.phone = c.phone AND c2.deleted_at IS NULL) as phone_count
        FROM contacts c
        LEFT JOIN cities ci ON ci.id = c.city_id
        ${whereClause}
        ORDER BY ${orderBy} ${orderDir}
        LIMIT ? OFFSET ?
      `;
      const dataArgs = [...args, limit, offset];
      const result = await statement(env, dataSql, ...dataArgs).all();
      const contactList = result.results || [];

      // Carregar categorias dos contatos retornados
      if(contactList.length > 0){
        const contactIds = contactList.map(c => c.id);
        const placeholders = contactIds.map(() => '?').join(',');
        const catRows = (await statement(env, `
          SELECT cc.contact_id, cat.id, cat.name, cat.color, cat.slug
          FROM contact_categories cc
          JOIN categories cat ON cat.id = cc.category_id
          WHERE cc.contact_id IN (${placeholders})
        `, ...contactIds).all()).results || [];

        const catMap = new Map();
        for(const row of catRows){
          if(!catMap.has(row.contact_id)) catMap.set(row.contact_id, []);
          catMap.get(row.contact_id).push({ id: row.id, name: row.name, color: row.color, slug: row.slug });
        }

        for(const c of contactList){
          c.categories = catMap.get(c.id) || [];
        }
      }

      // Listas para filtros
      const cities = (await statement(env, "SELECT id, name, state FROM cities ORDER BY name COLLATE NOCASE").all()).results || [];
      const categories = (await statement(env, "SELECT id, name, color, slug FROM categories ORDER BY name COLLATE NOCASE").all()).results || [];
      const dupCount = await statement(env, 'SELECT COUNT(*) as n FROM contacts WHERE phone IN (SELECT phone FROM contacts WHERE deleted_at IS NULL GROUP BY phone HAVING COUNT(*) > 1) AND deleted_at IS NULL').first();

      return json({
        contacts: contactList,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 1
        },
        cities: cities.map(c => c.name),
        cities_list: cities,
        categories,
        duplicateCount: dupCount?.n || 0
      });
    }

    if(url.pathname === '/api/contacts' && request.method === 'POST'){
      const d = await requestData(request, 15000);
      const company = cleanText(d.company, 150);
      if(!company) return json({ error: 'Nome do estabelecimento é obrigatório.' }, 400);

      const norm = normalizePhone(d.phone);
      if(!norm.valid) return json({ error: `Telefone inválido: ${norm.reason}` }, 400);

      // Verificação de duplicidade
      const existing = await statement(env, 'SELECT id, company, deleted_at FROM contacts WHERE (phone_e164 = ? OR phone = ?)', norm.phone_e164, norm.phone_digits).first();
      if(existing){
        if(existing.deleted_at){
          return json({
            error: `Este número já pertence ao contato "${existing.company}" que está na Lixeira. Deseja restaurá-lo?`,
            can_restore: true,
            contact_id: existing.id
          }, 409);
        }
        return json({
          error: `Telefone já cadastrado para "${existing.company}".`,
          duplicate_id: existing.id
        }, 409);
      }

      // Resolução de cidade
      let cityId = d.city_id || null;
      let cityName = cleanText(d.city || '', 120);
      let cityState = cleanText(d.state || '', 10).toUpperCase();

      if(cityId){
        const cRow = await statement(env, 'SELECT name, state FROM cities WHERE id = ?', cityId).first();
        if(cRow) { cityName = cRow.name; cityState = cRow.state; }
      } else if(cityName){
        cityName = normalizeCityName(cityName);
        const slug = generateCitySlug(cityName, cityState);
        let cRow = await statement(env, 'SELECT id, name FROM cities WHERE slug = ?', slug).first();
        if(!cRow){
          cityId = crypto.randomUUID();
          await statement(env, 'INSERT INTO cities (id, name, state, slug, created_at) VALUES (?, ?, ?, ?, ?)', cityId, cityName, cityState, slug, new Date().toISOString()).run();
        } else {
          cityId = cRow.id;
        }
      }

      const id = crypto.randomUUID(), now = new Date().toISOString();
      const responsible = cleanText(d.responsible || '', 150);
      const email = cleanText(d.email || '', 150);
      const instagram = cleanText(d.instagram || '', 100);
      const address = cleanText(d.address || '', 250);
      const notes = cleanText(d.notes || '', 1000);
      const status = cleanText(d.status || 'AGENDA', 30);
      const interested = Number(d.interested) ? 1 : 0;
      const source = cleanText(d.source || 'manual', 50);

      await statement(env, `
        INSERT INTO contacts (
          id, company, responsible, phone, phone_e164, phone_raw, city, city_id,
          email, instagram, address, notes, status, interested, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, company, responsible, norm.phone_digits, norm.phone_e164, d.phone, cityName || 'Geral', cityId, email, instagram, address, notes, status, interested, source, now, now).run();

      // Categorias
      if(Array.isArray(d.category_ids)){
        for(const catId of d.category_ids){
          if(catId) await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)', id, catId).run();
        }
      }

      await event(env, id, 'CREATED', 'Cadastro manual');
      return json({
        success: true,
        id,
        contact: {
          id,
          company,
          phone: norm.phone_digits,
          phone_e164: norm.phone_e164,
          city: cityName,
          city_id: cityId
        }
      });
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+$/) && request.method === 'GET'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const c = await statement(env, `
        SELECT c.*, ci.name as city_name, ci.state as city_state
        FROM contacts c
        LEFT JOIN cities ci ON ci.id = c.city_id
        WHERE c.id = ?
      `, id).first();
      if(!c) return json({ error: 'Contato não encontrado.' }, 404);

      const categories = (await statement(env, `
        SELECT cat.* FROM contact_categories cc
        JOIN categories cat ON cat.id = cc.category_id
        WHERE cc.contact_id = ?
      `, id).all()).results || [];

      const events = (await statement(env, `
        SELECT * FROM contact_events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 30
      `, id).all()).results || [];

      return json({ contact: { ...c, categories, events }, categories, events });
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+$/) && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const contact = await statement(env, 'SELECT * FROM contacts WHERE id = ?', id).first();
      if(!contact) return json({ error: 'Contato não encontrado.' }, 404);

      const d = await requestData(request, 15000);
      const company = cleanText(d.company || contact.company, 150);
      const responsible = cleanText(d.responsible !== undefined ? d.responsible : contact.responsible, 150);
      const notes = cleanText(d.notes !== undefined ? d.notes : contact.notes, 1000);
      const email = cleanText(d.email !== undefined ? d.email : contact.email, 150);
      const instagram = cleanText(d.instagram !== undefined ? d.instagram : contact.instagram, 100);
      const address = cleanText(d.address !== undefined ? d.address : contact.address, 250);
      const status = cleanText(d.status || contact.status, 30);
      const interested = d.interested !== undefined ? (Number(d.interested) ? 1 : 0) : contact.interested;

      // Mesclagem explícita de contatos
      if(d.merge_with_id){
        const targetId = d.merge_with_id;
        const target = await statement(env, 'SELECT * FROM contacts WHERE id = ?', targetId).first();
        if(!target) return json({ error: 'Contato de destino não encontrado para mesclar.' }, 404);

        // Move categorias, mensagens, eventos e remove o contato de origem
        await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) SELECT ?, category_id FROM contact_categories WHERE contact_id = ?', target.id, id).run();
        await statement(env, 'UPDATE chat_messages SET phone = ? WHERE phone = ?', target.phone, contact.phone).run();
        await statement(env, 'UPDATE sends SET phone = ? WHERE phone = ?', target.phone, contact.phone).run();
        await statement(env, 'UPDATE followups SET phone = ?, remote_jid = ? WHERE phone = ?', target.phone, target.phone + '@s.whatsapp.net', contact.phone).run();
        await statement(env, 'DELETE FROM send_queue WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM contact_events WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM contacts WHERE id = ?', id).run();
        await event(env, target.id, 'MERGED', `Contato "${contact.company}" mesclado neste registro.`);
        return json({ success: true, merged: true });
      }

      // Resolução de Telefone com Normalização e Verificação de Duplicados
      let phoneDigits = contact.phone;
      let phoneE164 = contact.phone_e164;
      let phoneRaw = contact.phone_raw;

      if(d.phone && d.phone !== contact.phone && d.phone !== contact.phone_e164){
        const norm = normalizePhone(d.phone);
        if(!norm.valid) return json({ error: `Telefone inválido: ${norm.reason}` }, 400);

        // Verifica se outro contato tem esse mesmo número
        const other = await statement(env, 'SELECT id, company, phone FROM contacts WHERE id != ? AND (phone_e164 = ? OR phone = ?) AND deleted_at IS NULL', id, norm.phone_e164, norm.phone_digits).first();

        if(other){
          return json({
            error: `O telefone ${norm.phone_e164} já pertence a "${other.company}". Deseja mesclar os contatos?`,
            can_merge: true,
            duplicate_id: other.id,
            duplicate_company: other.company
          }, 409);
        } else {
          // Atualiza telefone e propaga para tabelas relacionadas
          const oldPhone = contact.phone;
          phoneDigits = norm.phone_digits;
          phoneE164 = norm.phone_e164;
          phoneRaw = d.phone;

          await statement(env, 'UPDATE chat_messages SET phone = ? WHERE phone = ?', phoneDigits, oldPhone).run();
          await statement(env, 'UPDATE sends SET phone = ? WHERE phone = ?', phoneDigits, oldPhone).run();
          await statement(env, 'UPDATE followups SET phone = ?, remote_jid = ? WHERE phone = ?', phoneDigits, phoneDigits + '@s.whatsapp.net', oldPhone).run();
          await statement(env, 'UPDATE ai_human_interventions SET phone = ? WHERE phone = ?', phoneDigits, oldPhone).run();
          await event(env, id, 'PHONE_CHANGED', `Telefone alterado de ${oldPhone} para ${phoneDigits}`);
        }
      }

      // Resolução de cidade
      let cityId = d.city_id !== undefined ? d.city_id : contact.city_id;
      let cityName = d.city !== undefined ? cleanText(d.city, 120) : contact.city;

      if(d.city_id){
        const cRow = await statement(env, 'SELECT name FROM cities WHERE id = ?', d.city_id).first();
        if(cRow) cityName = cRow.name;
      } else if(d.city && d.city !== contact.city){
        cityName = normalizeCityName(d.city);
        const slug = generateCitySlug(cityName, cleanText(d.state || '', 10));
        let cRow = await statement(env, 'SELECT id, name FROM cities WHERE slug = ?', slug).first();
        if(!cRow){
          cityId = crypto.randomUUID();
          await statement(env, 'INSERT INTO cities (id, name, state, slug, created_at) VALUES (?, ?, ?, ?, ?)', cityId, cityName, cleanText(d.state || '', 10).toUpperCase(), slug, new Date().toISOString()).run();
        } else {
          cityId = cRow.id;
        }
      }

      const now = new Date().toISOString();
      await statement(env, `
        UPDATE contacts SET
          company = ?, responsible = ?, phone = ?, phone_e164 = ?, phone_raw = ?,
          city = ?, city_id = ?, email = ?, instagram = ?, address = ?, notes = ?,
          status = ?, interested = ?, updated_at = ?
        WHERE id = ?
      `, company, responsible, phoneDigits, phoneE164, phoneRaw, cityName, cityId, email, instagram, address, notes, status, interested, now, id).run();

      // Sincronização de categorias se informado
      if(Array.isArray(d.category_ids)){
        await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', id).run();
        for(const catId of d.category_ids){
          if(catId) await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)', id, catId).run();
        }
      }

      await event(env, id, 'EDITED');
      return json({ success: true });
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+$/) && request.method === 'DELETE'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const permanent = url.searchParams.get('permanent') === 'true';

      if(permanent){
        await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM send_queue WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM contact_events WHERE contact_id = ?', id).run();
        await statement(env, 'DELETE FROM contacts WHERE id = ?', id).run();
        return json({ success: true, permanent: true });
      }

      // Exclusão Lógica Segura
      const now = new Date().toISOString();
      const contact = await statement(env, 'SELECT phone, phone_e164 FROM contacts WHERE id = ?', id).first();
      await statement(env, "UPDATE contacts SET deleted_at = ?, status = 'AGENDA', updated_at = ? WHERE id = ?", now, now, id).run();
      await statement(env, "DELETE FROM send_queue WHERE contact_id = ? AND status IN ('QUEUED', 'PROCESSING')", id).run();
      if(contact){
        await statement(env, "UPDATE followups SET status = 'cancelled', cancel_reason = 'contact_deleted', updated_at = ? WHERE (phone = ? OR phone = ?) AND status = 'scheduled'", now, contact.phone, contact.phone_e164 || '').run();
      }
      await event(env, id, 'LOGICAL_DELETE', 'Contato movido para a lixeira');
      return json({ success: true, deleted: true });
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+\/restore$/) && request.method === 'POST'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const now = new Date().toISOString();
      const r = await statement(env, "UPDATE contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?", now, id).run();
      if(!r.meta?.changes) return json({ error: 'Contato não encontrado na lixeira.' }, 404);
      await event(env, id, 'RESTORED', 'Contato restaurado da lixeira');
      return json({ success: true });
    }

    if(url.pathname === '/api/contacts/bulk' && request.method === 'POST'){
      const d = await requestData(request, 100000);
      const action = d.action;
      let contactIds = Array.isArray(d.contactIds) ? d.contactIds : (Array.isArray(d.ids) ? d.ids : []);

      // Seleção por filtro ("todos do filtro")
      if((d.selectAllFromFilter || !contactIds.length) && d.filter){
        const f = d.filter;
        let where = f.trash ? 'WHERE deleted_at IS NOT NULL' : 'WHERE deleted_at IS NULL';
        const args = [];
        if(f.city_id){ where += ' AND city_id = ?'; args.push(f.city_id); }
        if(f.status){ where += ' AND status = ?'; args.push(f.status); }
        if(f.category_id){ where += ' AND EXISTS (SELECT 1 FROM contact_categories cc WHERE cc.contact_id = contacts.id AND cc.category_id = ?)'; args.push(f.category_id); }
        if(f.q){
          where += ' AND (company LIKE ? OR phone LIKE ?)';
          args.push('%' + f.q + '%', '%' + f.q + '%');
        }
        const rows = (await statement(env, `SELECT id FROM contacts ${where}`, ...args).all()).results || [];
        contactIds = rows.map(r => r.id);
      }

      if(!contactIds.length) return json({ error: 'Nenhum contato selecionado.' }, 400);

      const now = new Date().toISOString();
      let affected = 0;

      if(action === 'delete'){
        for(const cid of contactIds){
          await statement(env, "UPDATE contacts SET deleted_at = ?, status = 'AGENDA', updated_at = ? WHERE id = ?", now, now, cid).run();
          await statement(env, "DELETE FROM send_queue WHERE contact_id = ? AND status IN ('QUEUED', 'PROCESSING')", cid).run();
          await event(env, cid, 'LOGICAL_DELETE', 'Exclusão em massa');
          affected++;
        }
      } else if(action === 'restore'){
        for(const cid of contactIds){
          await statement(env, "UPDATE contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?", now, cid).run();
          await event(env, cid, 'RESTORED', 'Restauração em massa');
          affected++;
        }
      } else if(action === 'permanent_delete'){
        for(const cid of contactIds){
          await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', cid).run();
          await statement(env, 'DELETE FROM send_queue WHERE contact_id = ?', cid).run();
          await statement(env, 'DELETE FROM contact_events WHERE contact_id = ?', cid).run();
          await statement(env, 'DELETE FROM contacts WHERE id = ?', cid).run();
          affected++;
        }
      } else if(action === 'set_category'){
        const catId = d.categoryId || d.category_id || d.value;
        if(!catId) return json({ error: 'Categoria não informada.' }, 400);
        for(const cid of contactIds){
          await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', cid).run();
          await statement(env, 'INSERT INTO contact_categories (contact_id, category_id) VALUES (?, ?)', cid, catId).run();
          affected++;
        }
      } else if(action === 'add_category'){
        const catId = d.categoryId || d.category_id || d.value;
        if(!catId) return json({ error: 'Categoria não informada.' }, 400);
        for(const cid of contactIds){
          await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)', cid, catId).run();
          affected++;
        }
      } else if(action === 'remove_category'){
        const catId = d.categoryId || d.category_id || d.value;
        for(const cid of contactIds){
          await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ? AND category_id = ?', cid, catId).run();
          affected++;
        }
      } else if(action === 'set_city'){
        const cityId = d.cityId || d.city_id || d.value;
        const cRow = await statement(env, 'SELECT name FROM cities WHERE id = ?', cityId).first();
        if(!cRow) return json({ error: 'Cidade não encontrada.' }, 404);
        for(const cid of contactIds){
          await statement(env, 'UPDATE contacts SET city_id = ?, city = ?, updated_at = ? WHERE id = ?', cityId, cRow.name, now, cid).run();
          affected++;
        }
      } else if(action === 'set_status'){
        const newStatus = cleanText(d.status || d.value, 30);
        for(const cid of contactIds){
          await statement(env, 'UPDATE contacts SET status = ?, updated_at = ? WHERE id = ?', newStatus, now, cid).run();
          affected++;
        }
      } else if(action === 'enqueue'){
        const posRow = await statement(env, 'SELECT COALESCE(MAX(position), 0) as n FROM send_queue').first();
        let currentPos = Number(posRow?.n || 0);
        for(const cid of contactIds){
          const c = await statement(env, 'SELECT * FROM contacts WHERE id = ?', cid).first();
          if(!c) continue;
          const already = await statement(env, "SELECT id FROM send_queue WHERE contact_id = ? AND status IN ('QUEUED', 'PROCESSING')", cid).first();
          if(already) continue;
          currentPos++;
          const msgPayload = JSON.stringify({ mode: 'STANDARD', type: d.message_type || 'presentation', text: '' });
          await statement(env, `
            INSERT INTO send_queue (id, contact_id, status, message, position, created_at)
            VALUES (?, ?, 'QUEUED', ?, ?, ?)
          `, crypto.randomUUID(), cid, msgPayload, currentPos, now).run();
          await statement(env, "UPDATE contacts SET status = 'QUEUED', updated_at = ? WHERE id = ?", now, cid).run();
          affected++;
        }
      }

      return json({ success: true, affected });
    }

    // ========================================================================
    // IMPORTAÇÃO DE LISTAS (PREVIEW, COMMIT, UNDO, AUDITORIA, CSV DE ERROS)
    // ========================================================================
    if(url.pathname === '/api/import/preview' && request.method === 'POST'){
      const d = await requestData(request, 15000000);
      let rawRows = [];

      const fileBase64 = d.fileBase64 || d.base64;
      if(fileBase64){
        rawRows = parseSpreadsheetBuffer(fileBase64, d.filename || '');
      } else if(Array.isArray(d.rows)){
        rawRows = d.rows;
      }

      if(!rawRows.length) return json({ error: 'Nenhuma linha legível encontrada na planilha.' }, 400);

      const headers = Object.keys(rawRows[0] || {});
      const mapping = d.mapping || d.column_map || detectColumnMapping(headers);

      let toCreate = 0, toUpdate = 0, duplicates = 0, invalid = 0;
      const errors = [];
      const seenPhonesInBatch = new Set();

      // Buscar telefones existentes no banco para checagem rápida
      const existingPhonesList = (await statement(env, "SELECT phone_e164, phone FROM contacts WHERE deleted_at IS NULL").all()).results || [];
      const dbPhones = new Set();
      for(const row of existingPhonesList){
        if(row.phone_e164) dbPhones.add(row.phone_e164);
        if(row.phone) dbPhones.add(row.phone);
      }

      const previewRows = [];

      for(let i = 0; i < rawRows.length; i++){
        const item = rawRows[i];
        const company = cleanText(item[mapping.company] || item.company || item.estabelecimento || item.nome, 150);
        const rawPhone = item[mapping.phone] || item.phone || item.whatsapp || item.telefone;
        const norm = normalizePhone(rawPhone);

        if(!company){
          invalid++;
          if(errors.length < 150) errors.push({ row: i + 2, company: '—', phone: rawPhone || '—', reason: 'Nome do estabelecimento em branco' });
          continue;
        }

        if(!norm.valid){
          invalid++;
          if(errors.length < 150) errors.push({ row: i + 2, company, phone: rawPhone || '—', reason: norm.reason });
          continue;
        }

        const isDuplicateInBatch = seenPhonesInBatch.has(norm.phone_e164);
        const isDuplicateInDb = dbPhones.has(norm.phone_e164) || dbPhones.has(norm.phone_digits);

        if(isDuplicateInBatch || isDuplicateInDb){
          duplicates++;
          toUpdate++;
        } else {
          toCreate++;
          seenPhonesInBatch.add(norm.phone_e164);
        }

        if(previewRows.length < 15){
          previewRows.push({
            row: i + 2,
            row_index: i + 2,
            company,
            phone: norm.phone_e164,
            phone_normalized: norm.phone_e164,
            rawPhone,
            phone_raw: rawPhone,
            responsible: cleanText(item[mapping.responsible] || item.responsible || '', 150),
            city: cleanText(item[mapping.city] || item.city || item.cidade || '', 120),
            state: cleanText(item[mapping.state] || item.state || item.uf || '', 10).toUpperCase(),
            category: cleanText(item[mapping.category] || item.category || item.categoria || '', 100),
            status: (!norm.valid ? 'invalid' : (isDuplicateInDb ? 'duplicate_db' : (isDuplicateInBatch ? 'duplicate_file' : 'valid'))),
            isDuplicate: isDuplicateInBatch || isDuplicateInDb
          });
        }
      }

      const cities = (await statement(env, "SELECT id, name, state FROM cities ORDER BY name COLLATE NOCASE").all()).results || [];
      const categories = (await statement(env, "SELECT id, name, color FROM categories ORDER BY name COLLATE NOCASE").all()).results || [];

      return json({
        success: true,
        total: rawRows.length,
        total_rows: rawRows.length,
        to_create: toCreate,
        valid_contacts: toCreate + toUpdate,
        to_update: toUpdate,
        duplicates,
        duplicate_in_file: duplicates,
        invalid,
        invalid_phones: invalid,
        errors,
        preview_rows: previewRows,
        columns: headers,
        columns_detected: headers,
        column_mapping: mapping,
        suggested_mapping: mapping,
        cities,
        categories
      });
    }

    if(url.pathname === '/api/import/commit' && request.method === 'POST'){
      const d = await requestData(request, 15000000);
      const filename = cleanText(d.filename || 'importacao.xlsx', 200);
      const defaultCityId = d.defaultCityId || d.default_city_id || null;
      const defaultCategoryId = d.defaultCategoryId || d.default_category_id || null;
      let duplicateAction = d.duplicateAction || d.duplicate_policy || 'ignore';
      if(duplicateAction === 'skip') duplicateAction = 'ignore';
      const autoCreateCities = (d.autoCreateCities !== undefined ? d.autoCreateCities : d.auto_create_cities) !== false;
      const autoCreateCategories = (d.autoCreateCategories !== undefined ? d.autoCreateCategories : d.auto_create_categories) !== false;

      let rawRows = [];
      const fileBase64 = d.fileBase64 || d.base64;
      if(fileBase64){
        rawRows = parseSpreadsheetBuffer(fileBase64, filename);
      } else if(Array.isArray(d.rows)){
        rawRows = d.rows;
      }

      if(!rawRows.length) return json({ error: 'Nenhum contato para importar.' }, 400);

      const headers = Object.keys(rawRows[0] || {});
      const mapping = d.mapping || d.column_map || detectColumnMapping(headers);

      const batchId = crypto.randomUUID();
      const now = new Date().toISOString();

      await statement(env, `
        INSERT INTO import_batches (id, filename, total, created, updated, skipped, errors, created_at)
        VALUES (?, ?, ?, 0, 0, 0, 0, ?)
      `, batchId, filename, rawRows.length, now).run();

      // Caches locais para evitar consultas repetidas ao banco
      const cityCache = new Map();
      const catCache = new Map();

      const existingCities = (await statement(env, 'SELECT id, name, slug FROM cities').all()).results || [];
      for(const c of existingCities) cityCache.set(c.slug, c.id);

      const existingCats = (await statement(env, 'SELECT id, name, slug FROM categories').all()).results || [];
      for(const c of existingCats) catCache.set(c.slug, c.id);

      let created = 0, updated = 0, skipped = 0, errors = 0;
      const seenInBatch = new Set();

      for(let i = 0; i < rawRows.length; i++){
        const item = rawRows[i];
        const rowNum = i + 2;
        const company = cleanText(item[mapping.company] || item.company || item.estabelecimento || item.nome, 150);
        const rawPhone = item[mapping.phone] || item.phone || item.whatsapp || item.telefone;
        const norm = normalizePhone(rawPhone);

        if(!company || !norm.valid){
          errors++;
          await statement(env, 'INSERT INTO import_rows (id, batch_id, row_number, status, reason, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            crypto.randomUUID(), batchId, rowNum, 'INVALID', !company ? 'Estabelecimento em branco' : norm.reason, JSON.stringify(item), now).run();
          continue;
        }

        // Verifica duplicidade no banco
        const existing = await statement(env, 'SELECT id, city_id FROM contacts WHERE (phone_e164 = ? OR phone = ?) AND deleted_at IS NULL', norm.phone_e164, norm.phone_digits).first();

        let rowCity = cleanText(item[mapping.city] || item.city || item.cidade || '', 120);
        let rowState = cleanText(item[mapping.state] || item.state || item.uf || '', 10).toUpperCase();
        let rowCategory = cleanText(item[mapping.category] || item.category || item.categoria || '', 100);

        // Resolução de cidade
        let finalCityId = defaultCityId;
        if(rowCity){
          rowCity = normalizeCityName(rowCity);
          const slug = generateCitySlug(rowCity, rowState);
          if(cityCache.has(slug)){
            finalCityId = cityCache.get(slug);
          } else if(autoCreateCities){
            const newCityId = crypto.randomUUID();
            await statement(env, 'INSERT INTO cities (id, name, state, slug, created_at) VALUES (?, ?, ?, ?, ?)', newCityId, rowCity, rowState, slug, now).run();
            cityCache.set(slug, newCityId);
            finalCityId = newCityId;
          }
        }

        // Resolução de categoria
        let finalCategoryId = defaultCategoryId;
        if(rowCategory){
          const slug = generateCategorySlug(rowCategory);
          if(catCache.has(slug)){
            finalCategoryId = catCache.get(slug);
          } else if(autoCreateCategories){
            const newCatId = crypto.randomUUID();
            await statement(env, "INSERT INTO categories (id, name, slug, color, description, created_at) VALUES (?, ?, ?, '#64748b', '', ?)", newCatId, rowCategory, slug, now).run();
            catCache.set(slug, newCatId);
            finalCategoryId = newCatId;
          }
        }

        if(existing || seenInBatch.has(norm.phone_e164)){
          if(duplicateAction === 'ignore'){
            skipped++;
            await statement(env, 'INSERT INTO import_rows (id, batch_id, row_number, status, reason, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              crypto.randomUUID(), batchId, rowNum, 'SKIPPED', 'Duplicado ignorado', JSON.stringify({ company, phone: norm.phone_e164 }), now).run();
            continue;
          }

          if(existing && (duplicateAction === 'update' || duplicateAction === 'merge_categories')){
            if(duplicateAction === 'update'){
              await statement(env, `
                UPDATE contacts
                SET company = COALESCE(?, company),
                    city_id = COALESCE(?, city_id),
                    city = COALESCE(?, city),
                    updated_at = ?
                WHERE id = ?
              `, company, finalCityId, rowCity, now, existing.id).run();
            }
            if(finalCategoryId){
              await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)', existing.id, finalCategoryId).run();
            }
            updated++;
            await statement(env, 'INSERT INTO import_rows (id, batch_id, row_number, status, reason, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              crypto.randomUUID(), batchId, rowNum, 'UPDATED', 'Contato atualizado/mesclado', JSON.stringify({ company, phone: norm.phone_e164 }), now).run();
            continue;
          }
        }

        seenInBatch.add(norm.phone_e164);
        const contactId = crypto.randomUUID();
        const responsible = cleanText(item[mapping.responsible] || item.responsible || '', 150);
        const email = cleanText(item[mapping.email] || item.email || '', 150);
        const instagram = cleanText(item[mapping.instagram] || item.instagram || '', 100);
        const address = cleanText(item[mapping.address] || item.address || '', 250);
        const notes = cleanText(item[mapping.notes] || item.notes || '', 1000);

        await statement(env, `
          INSERT INTO contacts (
            id, company, responsible, phone, phone_e164, phone_raw, city, city_id,
            email, instagram, address, notes, status, interested, source, import_batch_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGENDA', 0, 'importacao', ?, ?, ?)
        `, contactId, company, responsible, norm.phone_digits, norm.phone_e164, rawPhone, rowCity || 'Geral', finalCityId, email, instagram, address, notes, batchId, now, now).run();

        if(finalCategoryId){
          await statement(env, 'INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)', contactId, finalCategoryId).run();
        }

        await statement(env, 'INSERT INTO import_rows (id, batch_id, row_number, status, reason, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), batchId, rowNum, 'CREATED', 'Contato importado com sucesso', null, now).run();

        created++;
      }

      await statement(env, `
        UPDATE import_batches
        SET created = ?, updated = ?, skipped = ?, errors = ?
        WHERE id = ?
      `, created, updated, skipped, errors, batchId).run();

      return json({
        success: true,
        batchId,
        batch_id: batchId,
        id: batchId,
        total: rawRows.length,
        created,
        updated,
        skipped,
        duplicates: skipped,
        errors,
        invalid: errors
      });
    }

    if(url.pathname.match(/^\/api\/import\/[^/]+\/undo$/) && request.method === 'POST'){
      const batchId = decodeURIComponent(url.pathname.split('/')[3]);
      const rows = (await statement(env, `
        SELECT id FROM contacts
        WHERE import_batch_id = ?
          AND last_sent_at IS NULL
          AND id NOT IN (SELECT contact_id FROM send_queue WHERE status IN ('QUEUED', 'PROCESSING', 'SENT'))
      `, batchId).all()).results || [];

      let removed = 0;
      for(const r of rows){
        await statement(env, 'DELETE FROM contact_categories WHERE contact_id = ?', r.id).run();
        await statement(env, 'DELETE FROM contact_events WHERE contact_id = ?', r.id).run();
        await statement(env, 'DELETE FROM contacts WHERE id = ?', r.id).run();
        removed++;
      }

      await statement(env, "UPDATE import_batches SET filename = filename || ' (DESFEITO)' WHERE id = ?", batchId).run();
      return json({ success: true, removedCount: removed, removed });
    }

    if(url.pathname === '/api/import/batches' && request.method === 'GET'){
      const rows = (await statement(env, `
        SELECT b.*,
          (SELECT COUNT(*) FROM contacts c WHERE c.import_batch_id = b.id AND c.last_sent_at IS NULL) as can_undo_count
        FROM import_batches b
        ORDER BY b.created_at DESC
        LIMIT 40
      `).all()).results || [];
      return json({ batches: rows });
    }

    if(url.pathname.match(/^\/api\/import\/[^/]+\/errors\/csv$/) && request.method === 'GET'){
      const batchId = decodeURIComponent(url.pathname.split('/')[3]);
      const rows = (await statement(env, 'SELECT row_number, status, reason, data_json FROM import_rows WHERE batch_id = ? AND status = ? ORDER BY row_number', batchId, 'INVALID').all()).results || [];

      let csv = 'Linha,Status,Motivo,Dados\n';
      for(const r of rows){
        const sanitizedReason = (r.reason || '').replace(/"/g, '""');
        const sanitizedData = (r.data_json || '').replace(/"/g, '""');
        csv += `${r.row_number},"${r.status}","${sanitizedReason}","${sanitizedData}"\n`;
      }
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="erros-importacao-${batchId.slice(0, 8)}.csv"`
        }
      });
    }

    // Suporte ao endpoint legado /api/contacts/import para garantir 100% de compatibilidade
    if(url.pathname === '/api/contacts/import' && request.method === 'POST'){
      const data = await requestData(request, 10000000);
      const defaultCity = cleanText(data.city || '', 120);
      if(!Array.isArray(data.contacts) || !data.contacts.length) return json({ error: 'Nenhum contato encontrado para importação.' }, 400);
      let imported = 0, duplicates = 0, skipped = 0;
      const existingRows = (await statement(env, "SELECT phone, phone_e164 FROM contacts WHERE deleted_at IS NULL").all()).results || [];
      const existingPhones = new Set();
      for(const r of existingRows){
        if(r.phone) existingPhones.add(r.phone);
        if(r.phone_e164) existingPhones.add(r.phone_e164);
      }
      const seenInBatch = new Set();

      for(const item of data.contacts.slice(0, 5000)){
        const company = cleanText(item.company || item.estabelecimento || item.name, 150);
        const norm = normalizePhone(item.phone || item.whatsapp || item.telefone);
        if(!company || !norm.valid){
          skipped++;
          continue;
        }
        if(existingPhones.has(norm.phone_digits) || existingPhones.has(norm.phone_e164) || seenInBatch.has(norm.phone_e164)){
          duplicates++;
          skipped++;
          continue;
        }
        seenInBatch.add(norm.phone_e164);
        existingPhones.add(norm.phone_digits);
        existingPhones.add(norm.phone_e164);

        const rowCity = cleanText(item.city || item.cidade, 120) || defaultCity || 'Geral';
        const responsible = cleanText(item.responsible || item.responsavel || item.categoria || item.category, 150);
        const id = crypto.randomUUID(), now = new Date().toISOString();
        const r = await statement(env, 'INSERT OR IGNORE INTO contacts(id, company, responsible, phone, phone_e164, phone_raw, city, notes, status, interested, created_at, imported_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, company, responsible, norm.phone_digits, norm.phone_e164, item.phone, rowCity, cleanText(item.notes, 1000), 'AGENDA', 0, now, now).run();
        if(r.meta?.changes){
          imported++;
          await event(env, id, 'IMPORTED', 'Cidade: ' + rowCity);
        } else {
          skipped++;
        }
      }
      return json({ success: true, imported, duplicates, skipped });
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+\/interest$/) && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.split('/')[3]), data = await requestData(request, 1000), value = data.interested === true;
      const r = await statement(env, "UPDATE contacts SET interested=?, status=CASE WHEN ?=1 THEN 'INTERESTED' ELSE CASE WHEN last_sent_at IS NULL THEN 'AGENDA' ELSE 'SENT' END END WHERE id=?", value ? 1 : 0, value ? 1 : 0, id).run();
      if(r.meta?.changes) await event(env, id, value ? 'INTERESTED' : 'INTEREST_REMOVED');
      return r.meta?.changes ? json({ success: true }) : json({ error: 'Contato não encontrado.' }, 404);
    }

    if(url.pathname.match(/^\/api\/contacts\/[^/]+\/return$/) && request.method === 'POST'){
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const r = await statement(env, "UPDATE contacts SET status='AGENDA' WHERE id=?", id).run();
      if(r.meta?.changes) await event(env, id, 'RETURNED_TO_AGENDA');
      return r.meta?.changes ? json({ success: true }) : json({ error: 'Contato não encontrado.' }, 404);
    }

    // ========================================================================
    // FILA DE DISPARO (SEND_QUEUE) - INTEGRADA COM CIDADE E CATEGORIA
    // ========================================================================
    if(url.pathname === '/api/queue' && request.method === 'GET'){
      const r = await statement(env, "SELECT q.*, c.company, c.phone, c.city, c.interested FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status IN ('QUEUED','PROCESSING','ERROR') ORDER BY q.position, q.created_at").all();
      return json({ entries: r.results || [] });
    }

    if(url.pathname === '/api/queue' && request.method === 'DELETE'){
      const rows = (await statement(env, "SELECT id, contact_id FROM send_queue WHERE status IN ('QUEUED','ERROR')").all()).results || [];
      for(const row of rows){
        await statement(env, 'DELETE FROM send_queue WHERE id=?', row.id).run();
        await statement(env, "UPDATE contacts SET status='AGENDA' WHERE id=?", row.contact_id).run();
        await event(env, row.contact_id, 'QUEUE_CLEARED');
      }
      return json({ success: true, cleared: rows.length });
    }

    if(url.pathname === '/api/queue' && request.method === 'POST'){
      const data = await requestData(request, 25000);
      const limit = Math.max(1, Math.min(500, Number(data.quantity) || 20));
      const city = cleanText(data.city, 120);
      const cityId = cleanText(data.cityId || data.city_id || '', 60);
      const categoryId = cleanText(data.categoryId || data.category_id || '', 60);
      const q = cleanText(data.q, 150);

      let contacts = [];
      if(Array.isArray(data.contactIds) && data.contactIds.length){
        for(const id of data.contactIds.slice(0, 500)){
          const c = await statement(env, "SELECT id, company, phone, city, last_sent_at FROM contacts WHERE id=? AND status='AGENDA' AND deleted_at IS NULL", cleanText(id, 100)).first();
          if(c) contacts.push(c);
        }
      } else {
        let sql = "SELECT id, company, phone, city, last_sent_at FROM contacts WHERE status='AGENDA' AND deleted_at IS NULL";
        const args = [];
        if(cityId){
          sql += ' AND city_id=?';
          args.push(cityId);
        } else if(city){
          sql += ' AND city=?';
          args.push(city);
        }
        if(categoryId){
          sql += ' AND EXISTS (SELECT 1 FROM contact_categories cc WHERE cc.contact_id = contacts.id AND cc.category_id = ?)';
          args.push(categoryId);
        }
        if(q){
          sql += ' AND (company LIKE ? OR phone LIKE ? OR city LIKE ?)';
          args.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
        }
        sql += ' ORDER BY company COLLATE NOCASE LIMIT ?';
        args.push(limit);
        contacts = (await statement(env, sql, ...args).all()).results || [];
      }

      const settings = await savedSettings(env);
      const cfg = settings ? JSON.parse(settings.config_json) : {};
      const type = TEMPLATE_KEYS.includes(data.type) ? data.type : 'initial';
      const mode = data.mode === 'AI' ? 'AI' : 'STANDARD';
      const tmpl = cfg.templates?.[type] || 'Olá {empresa}!';

      let added = 0;
      const pos = await statement(env, 'SELECT COALESCE(MAX(position),0) n FROM send_queue').first();
      let position = Number(pos?.n || 0);
      for(const c of contacts){
        if(c.last_sent_at && !data.allowResend) continue;
        const id = crypto.randomUUID();
        let message = parseSpintax(String(tmpl).replaceAll('{empresa}', c.company || '').replaceAll('{telefone}', c.phone || ''));
        if(mode === 'AI') message = '[IA] ' + message;
        const msgPayload = JSON.stringify({ mode, type, text: message });
        try{
          await statement(env, "INSERT INTO send_queue(id, contact_id, status, message, position, created_at) VALUES(?,?,'QUEUED',?,?,?)", id, c.id, msgPayload, ++position, new Date().toISOString()).run();
          await statement(env, "UPDATE contacts SET status='QUEUED' WHERE id=?", c.id).run();
          await event(env, c.id, 'QUEUED');
          added++;
        }catch{}
      }
      return json({ success: true, added });
    }

    if(url.pathname === '/api/queue/prepare' && request.method === 'POST'){
      const data = await requestData(request, 10000), type = TEMPLATE_KEYS.includes(data.type) ? data.type : 'initial', mode = data.mode === 'AI' ? 'AI' : 'STANDARD', settings = await savedSettings(env);
      if(!settings) return json({ error: 'Configure as mensagens primeiro.' }, 409);
      const config = JSON.parse(settings.config_json), rows = (await statement(env, "SELECT q.id, c.company, c.phone FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status='QUEUED' ORDER BY q.position").all()).results || [];
      let prepared = 0;
      for(const row of rows){
        let message = parseSpintax(String(config.templates?.[type] || '').replaceAll('{empresa}', row.company || '').replaceAll('{telefone}', row.phone || ''));
        if(mode === 'AI') message = '[IA] ' + message;
        await statement(env, 'UPDATE send_queue SET message=? WHERE id=?', JSON.stringify({ mode, type, text: message }), row.id).run();
        prepared++;
      }
      return json({ success: true, prepared, mode, type });
    }

    if(url.pathname.match(/^\/api\/queue\/[^/]+$/) && request.method === 'DELETE'){
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const row = await statement(env, 'SELECT contact_id FROM send_queue WHERE id=? AND status=?', id, 'QUEUED').first();
      if(!row) return json({ error: 'Item não pode ser removido.' }, 409);
      await statement(env, 'DELETE FROM send_queue WHERE id=?', id).run();
      await statement(env, "UPDATE contacts SET status='AGENDA' WHERE id=?", row.contact_id).run();
      await event(env, row.contact_id, 'QUEUE_REMOVED');
      return json({ success: true });
    }

    if(url.pathname === '/api/queue/control' && request.method === 'POST'){
      const d = await requestData(request, 2000), action = String(d.action || '').toUpperCase(), map = { START: 'RUNNING', RESUME: 'RUNNING', PAUSE: 'PAUSED', STOP: 'STOPPED' };
      if(!map[action]) return json({ error: 'Ação inválida.' }, 400);
      if(action === 'START' || action === 'RESUME'){
        await statement(env, "UPDATE send_queue SET status='QUEUED', error=NULL WHERE status='ERROR'").run();
        const queued = await statement(env, "SELECT COUNT(*) n FROM send_queue WHERE status='QUEUED'").first();
        if(!(queued?.n > 0)) return json({ error: 'Não há contatos aguardando envio.' }, 409);
        const connected = await statement(env, "SELECT COUNT(*) n FROM instances WHERE status='CONNECTED'").first();
        if(!(connected?.n > 0)) return json({ error: 'Conecte pelo menos uma instância antes de iniciar.' }, 409);
        const settings = await savedSettings(env);
        if(settings){
          const cfg = JSON.parse(settings.config_json);
          const unmsg = (await statement(env, "SELECT q.id, c.company, c.phone FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status='QUEUED' AND (q.message IS NULL OR q.message='')").all()).results || [];
          for(const u of unmsg){
            const text = parseSpintax(String(cfg.templates?.initial || 'Olá {empresa}!').replaceAll('{empresa}', u.company || '').replaceAll('{telefone}', u.phone || ''));
            await statement(env, 'UPDATE send_queue SET message=? WHERE id=?', JSON.stringify({ mode: 'STANDARD', type: 'initial', text }), u.id).run();
          }
        }
        const now = new Date().toISOString();
        await statement(env, 'UPDATE send_rules SET queue_state=?, next_send_at=?, last_error=NULL, updated_at=? WHERE id=1', map[action], now, now).run();
      } else {
        await statement(env, 'UPDATE send_rules SET queue_state=?, next_send_at=NULL, updated_at=? WHERE id=1', map[action], new Date().toISOString()).run();
      }
      const message = map[action] === 'RUNNING' ? 'Fila iniciada.' : map[action] === 'PAUSED' ? 'Fila pausada.' : 'Fila parada.';
      return json({ success: true, state: map[action], message });
    }

    if(url.pathname === '/api/send-rules'){
      if(request.method === 'GET'){
        const r = await statement(env, 'SELECT * FROM send_rules WHERE id=1').first();
        let remainingSeconds = null;
        if(r?.queue_state === 'RUNNING' && r?.next_send_at){
          remainingSeconds = Math.max(0, Math.ceil((new Date(r.next_send_at).getTime() - Date.now()) / 1000));
        }
        return json({ rules: { ...r, remainingSeconds } });
      }
      if(request.method === 'PUT'){
        const d = await requestData(request, 5000), min = Math.max(1, Number(d.minSeconds) || 60), max = Math.max(min, Number(d.maxSeconds) || 180), cycle = Math.max(1, Number(d.messagesPerCycle) || 10), rest = Math.max(0, Number(d.restMinutes) || 20), sw = Math.max(1, Number(d.switchAfter) || 10);
        await statement(env, 'UPDATE send_rules SET min_seconds=?, max_seconds=?, messages_per_cycle=?, rest_minutes=?, switch_after=?, updated_at=? WHERE id=1', min, max, cycle, rest, sw, new Date().toISOString()).run();
        return json({ success: true });
      }
    }

    if(url.pathname === '/api/instances' && request.method === 'GET'){
      const r = await statement(env, "SELECT id, name, status, COALESCE(provider,'EVOLUTION_API') AS provider, api_url AS apiUrl, last_checked_at AS lastCheckedAt, rest_until AS restUntil, sent_in_cycle AS sentInCycle, min_seconds AS minSeconds, max_seconds AS maxSeconds, messages_per_cycle AS messagesPerCycle, rest_minutes AS restMinutes, COALESCE(role,'ALL') AS role FROM instances ORDER BY name").all();
      return json({ instances: r.results || [] });
    }

    if(url.pathname.startsWith('/api/instances/') && request.method === 'DELETE'){
      const id = decodeURIComponent(url.pathname.slice('/api/instances/'.length));
      await statement(env, 'DELETE FROM instances WHERE id=?', id).run();
      return json({ success: true });
    }

    if(url.pathname === '/api/instances' && request.method === 'POST'){
      const d = await requestData(request, 7000), provider = d.provider === 'EVOLUTION_GO' ? 'EVOLUTION_GO' : 'EVOLUTION_API', name = cleanText(d.name, 100), apiUrl = cleanText(d.apiUrl, 500).replace(/\/$/, '');
      const token = String(d.token || '').trim(), role = ['ALL', 'DISPARO', 'IA'].includes(d.role) ? d.role : 'ALL', minSeconds = Math.max(1, Number(d.minSeconds) || 60), maxSeconds = Math.max(minSeconds, Number(d.maxSeconds) || 180), messagesPerCycle = Math.max(1, Number(d.messagesPerCycle) || 10), restMinutes = Math.max(0, Number(d.restMinutes) || 20);
      if(!name || !apiUrl || !token) return json({ error: 'Informe serviço, nome, URL e API Key.' }, 400);
      const instanceToken = provider === 'EVOLUTION_GO' ? Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('') : '';
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await statement(env, "INSERT INTO instances(id, name, status, provider, api_url, token_cipher, instance_token_cipher, min_seconds, max_seconds, messages_per_cycle, rest_minutes, role, created_at, updated_at) VALUES(?,?,'DISCONNECTED',?,?,?,?,?,?,?,?,?,?,?)", id, name, provider, apiUrl, await encryptSecret(token, env), instanceToken ? await encryptSecret(instanceToken, env) : null, minSeconds, maxSeconds, messagesPerCycle, restMinutes, role, now, now).run();
      return json({ success: true, id });
    }

    if(url.pathname.match(/^\/api\/instances\/[^/]+$/) && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.split('/')[3]), row = await statement(env, 'SELECT * FROM instances WHERE id=?', id).first();
      if(!row) return json({ error: 'Instância não encontrada.' }, 404);
      const d = await requestData(request, 7000), provider = d.provider === 'EVOLUTION_GO' ? 'EVOLUTION_GO' : 'EVOLUTION_API', name = cleanText(d.name, 100), apiUrl = cleanText(d.apiUrl, 500).replace(/\/$/, '');
      const token = String(d.token || '').trim(), role = ['ALL', 'DISPARO', 'IA'].includes(d.role) ? d.role : (row.role || 'ALL'), minSeconds = Math.max(1, Number(d.minSeconds) || row.min_seconds || 60), maxSeconds = Math.max(minSeconds, Number(d.maxSeconds) || row.max_seconds || 180), messagesPerCycle = Math.max(1, Number(d.messagesPerCycle) || row.messages_per_cycle || 10), restMinutes = Math.max(0, Number(d.restMinutes) ?? row.rest_minutes ?? 20);
      if(!name || !apiUrl) return json({ error: 'Informe serviço, nome e URL.' }, 400);
      let tokenCipher = row.token_cipher, instanceTokenCipher = row.instance_token_cipher;
      if(token) tokenCipher = await encryptSecret(token, env);
      if(provider === 'EVOLUTION_GO' && !instanceTokenCipher){
        const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        instanceTokenCipher = await encryptSecret(generated, env);
      }
      await statement(env, "UPDATE instances SET name=?, provider=?, api_url=?, token_cipher=?, instance_token_cipher=?, min_seconds=?, max_seconds=?, messages_per_cycle=?, rest_minutes=?, role=?, status='DISCONNECTED', updated_at=? WHERE id=?", name, provider, apiUrl, tokenCipher, instanceTokenCipher, minSeconds, maxSeconds, messagesPerCycle, restMinutes, role, new Date().toISOString(), id).run();
      return json({ success: true });
    }

    if(url.pathname.match(/^\/api\/instances\/[^/]+\/(connect|status)$/) && request.method === 'POST'){
      const parts = url.pathname.split('/'), id = decodeURIComponent(parts[3]), action = parts[4];
      const row = await statement(env, 'SELECT * FROM instances WHERE id=?', id).first();
      if(!row) return json({ error: 'Instância não encontrada.' }, 404);
      if(!row.api_url || !row.token_cipher) return json({ error: 'Configure URL e API Key.' }, 400);
      let globalToken, instanceToken = '';
      try{
        globalToken = await decryptSecret(row.token_cipher, env);
        if(row.instance_token_cipher) instanceToken = await decryptSecret(row.instance_token_cipher, env);
      }catch{ return json({ error: 'Não foi possível abrir as credenciais salvas.' }, 503); }
      const provider = row.provider || 'EVOLUTION_API', base = String(row.api_url).replace(/\/$/, '');
      const call = async(path, key, options = {}) => {
        const resp = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', 'apikey': key, ...(options.headers || {}) }, signal: AbortSignal.timeout(20000) });
        let data = {};
        try{ data = await resp.json(); }catch{}
        return { ok: resp.ok, status: resp.status, data };
      };
      const configureWebhook = async() => {
        try{
          const webhookUrl = url.origin + '/api/webhook';
          if(provider === 'EVOLUTION_GO'){
            await call('/webhook', instanceToken || globalToken, { method: 'POST', body: JSON.stringify({ enabled: true, url: webhookUrl, events: ['messages.upsert', 'messages', 'presence.update', 'send.message', 'connection.update'] }) });
          } else {
            await call('/webhook/set/' + encodeURIComponent(row.name), globalToken, { method: 'POST', body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'] }, enabled: true, url: webhookUrl, webhookByEvents: false, events: ['MESSAGES_UPSERT', 'messages.upsert', 'SEND_MESSAGE', 'send.message', 'CONNECTION_UPDATE', 'connection.update'] }) });
          }
        }catch{}
      };

      if(provider === 'EVOLUTION_GO'){
        if(!instanceToken) return json({ error: 'Token da instância Evolution GO não configurado.' }, 400);
        if(action === 'status'){
          const r = await call('/instance/status', instanceToken);
          const connected = !!(r.data?.data?.loggedIn ?? r.data?.loggedIn ?? r.data?.data?.connected ?? r.data?.connected);
          await statement(env, 'UPDATE instances SET status=?, last_checked_at=?, updated_at=? WHERE id=?', connected ? 'CONNECTED' : 'DISCONNECTED', new Date().toISOString(), new Date().toISOString(), id).run();
          if(connected) await configureWebhook();
          if(!r.ok) return json({ error: r.data?.message || 'Não foi possível consultar a Evolution GO.' }, 502);
          return json({ success: true, connected });
        }
        const created = await call('/instance/create', globalToken, { method: 'POST', body: JSON.stringify({ name: row.name, token: instanceToken }) });
        if(!created.ok && ![400, 409, 422].includes(created.status)) return json({ error: created.data?.message || 'Falha ao criar a instância na Evolution GO.' }, 502);
        const connected = await call('/instance/connect', instanceToken, { method: 'POST', body: '{}' });
        if(!connected.ok && ![400, 409, 422].includes(connected.status)) return json({ error: connected.data?.message || 'Falha ao iniciar conexão na Evolution GO.' }, 502);
        await configureWebhook();
        await new Promise(r => setTimeout(r, 800));
        const qrRes = await call('/instance/qr', instanceToken);
        if(!qrRes.ok) return json({ error: qrRes.data?.message || 'Evolution GO não retornou o QR Code.' }, 502);
        const qr = qrRes.data?.data?.code || qrRes.data?.code || qrRes.data?.data?.qrcode || qrRes.data?.qrcode || null;
        return json({ success: true, connected: false, qr });
      }

      if(action === 'status'){
        const r = await call('/instance/connectionState/' + encodeURIComponent(row.name), globalToken);
        const state = String(r.data?.instance?.state || r.data?.state || '').toLowerCase(), connected = state === 'open' || state === 'connected';
        await statement(env, 'UPDATE instances SET status=?, last_checked_at=?, updated_at=? WHERE id=?', connected ? 'CONNECTED' : 'DISCONNECTED', new Date().toISOString(), new Date().toISOString(), id).run();
        if(connected) await configureWebhook();
        if(!r.ok) return json({ error: r.data?.message || 'Não foi possível consultar a Evolution API.' }, 502);
        return json({ success: true, connected, state });
      }

      const created = await call('/instance/create', globalToken, { method: 'POST', body: JSON.stringify({ instanceName: row.name, qrcode: true, integration: 'WHATSAPP-BAILEYS' }) });
      if(!created.ok && ![400, 403, 409, 422].includes(created.status)) return json({ error: created.data?.message || 'Falha ao criar a instância na Evolution API.' }, 502);
      await configureWebhook();
      const conn = await call('/instance/connect/' + encodeURIComponent(row.name), globalToken);
      if(!conn.ok) return json({ error: conn.data?.message || 'A Evolution API não retornou o QR Code.' }, 502);
      const qr = conn.data?.base64 || conn.data?.qrcode?.base64 || conn.data?.qr || conn.data?.code || created.data?.qrcode?.base64 || created.data?.base64 || null;
      return json({ success: true, connected: false, qr });
    }

    if(url.pathname === '/api/settings/key'){
      if(request.method !== 'PUT') return json({ error: 'Método não permitido.' }, 405);
      const data = await requestData(request, 2500);
      const key = normalizeApiKey(data?.apiKey);
      if(!key || key.length > 512) return json({ error: 'Insira a chave Gemini antes de salvar.' }, 400);
      const row = await savedSettings(env);
      if(!row) return json({ error: 'Aguarde as configurações carregarem e tente novamente.' }, 409);
      await statement(env, 'UPDATE settings SET key_cipher = ?, updated_at = ? WHERE id = ?', await encryptSecret(key, env), new Date().toISOString(), 1).run();
      return json({ hasApiKey: true });
    }

    if(url.pathname === '/api/settings'){
      if(request.method === 'GET'){
        const row = await savedSettings(env);
        const insts = (await statement(env, "SELECT id, name, status, COALESCE(provider,'EVOLUTION_API') AS provider, api_url AS apiUrl, COALESCE(role,'ALL') AS role FROM instances ORDER BY name").all()).results || [];
        let pausedCount = 0;
        try{
          const pc = await statement(env, "SELECT COUNT(*) n FROM ai_human_interventions WHERE datetime(paused_until) > datetime('now')").first();
          pausedCount = pc?.n || 0;
        }catch{}
        return json({
          config: row ? JSON.parse(row.config_json) : null,
          hasApiKey: !!(row?.key_cipher || env.GEMINI_API_KEY),
          instancesCount: insts.length,
          connectedCount: insts.filter(i => i.status === 'CONNECTED').length,
          instances: insts,
          pausedCount
        });
      }
      if(request.method !== 'PUT') return json({ error: 'Método não permitido.' }, 405);
      const data = await requestData(request);
      if(!validConfig(data.config)) return json({ error: 'Confira a oferta, opções e os cinco modelos de mensagem.' }, 400);
      const row = await savedSettings(env);
      if(data.initializeOnly && row) return json({ config: JSON.parse(row.config_json), hasApiKey: !!(row.key_cipher || env.GEMINI_API_KEY) });
      let cipher = row?.key_cipher || null;
      if(data.removeApiKey === true) cipher = null;
      else if(data.apiKey){
        const key = normalizeApiKey(data.apiKey);
        if(!key || key.length > 512) return json({ error: 'Confira a chave Gemini inserida.' }, 400);
        cipher = await encryptSecret(key, env);
      }
      const operation = data.initializeOnly
        ? 'INSERT OR IGNORE INTO settings (id, config_json, key_cipher, updated_at) VALUES (?, ?, ?, ?)'
        : 'INSERT INTO settings (id, config_json, key_cipher, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, key_cipher=excluded.key_cipher, updated_at=excluded.updated_at';
      await statement(env, operation, 1, JSON.stringify(data.config), cipher, new Date().toISOString()).run();
      const updated = await savedSettings(env);
      return json({ config: JSON.parse(updated.config_json), hasApiKey: !!(updated.key_cipher || env.GEMINI_API_KEY) });
    }

    if(url.pathname === '/api/ai/toggle' && (request.method === 'POST' || request.method === 'PUT')){
      const body = await requestData(request, 5000);
      const row = await savedSettings(env);
      if(!row) return json({ error: 'Configurações não encontradas.' }, 404);
      const cfg = JSON.parse(row.config_json);
      cfg.aiEnabled = typeof body.enabled === 'boolean' ? body.enabled : !cfg.aiEnabled;
      await statement(env, 'UPDATE settings SET config_json=?, updated_at=? WHERE id=1', JSON.stringify(cfg), new Date().toISOString()).run();
      return json({ success: true, aiEnabled: cfg.aiEnabled });
    }

    if(url.pathname === '/api/ai/test' && request.method === 'POST'){
      const data = await requestData(request, 25000);
      const userMessage = cleanText(data.message || data.userMessage || '', 1500);
      if(!userMessage) return json({ error: 'Digite uma mensagem para testar a IA.' }, 400);
      const settings = await savedSettings(env);
      if(!settings) return json({ error: 'Configurações não encontradas.' }, 404);
      const cfg = JSON.parse(settings.config_json);
      const apiKey = await configuredApiKey(env);

      let instructions = cleanText(data.customPrompt || cfg.aiPrompt || '', 15000);
      if(instructions.trim()){
        instructions = instructions
          .replaceAll('{empresa}', data.company || 'Restaurante Exemplo')
          .replaceAll('{oferta}', cfg.offer || '')
          .replaceAll('{cadastro}', cfg.aiRegistration || '')
          .replaceAll('{handoff}', cfg.aiHandoff || '')
          .replaceAll('{instrucoes}', cfg.aiInstructions || '');
      } else {
        instructions = `Você é a atendente virtual e especialista de vendas da Delivale.com no WhatsApp conversando diretamente com o cliente (${data.company || 'Restaurante Exemplo'}).
Como explicar o serviço:
${cfg.aiInstructions || 'A Delivale é um portal de pedidos e cardápio digital para delivery com 30 dias grátis.'}
Dados que devem ser solicitados:
${cfg.aiRegistration || 'Nome, WhatsApp, cidade e segmento.'}
Mensagem de conclusão:
${cfg.aiHandoff || 'Agradeça e informe os próximos passos.'}
Oferta cadastrada:
${cfg.offer || ''}
Responda em português do Brasil de forma amigável, clara, empática e objetiva. Responda apenas o texto da mensagem a ser enviada no WhatsApp.`;
      }

      const contents = [];
      if(Array.isArray(data.history) && data.history.length > 0){
        for(const h of data.history.slice(-8)){
          const role = h.role === 'model' ? 'model' : 'user';
          const txt = cleanText(h.text || h.content || '', 1000);
          if(!txt) continue;
          if(contents.length && contents[contents.length - 1].role === role){
            contents[contents.length - 1].parts[0].text += '\n' + txt;
          } else {
            contents.push({ role, parts: [{ text: txt }] });
          }
        }
      }
      if(contents.length === 0 || contents[contents.length - 1].role !== 'user'){
        contents.push({ role: 'user', parts: [{ text: userMessage }] });
      }

      const preferredModel = cleanText(data.model || cfg.aiModel || env.GEMINI_MODEL || 'gemini-2.5-flash', 50);
      const modelsToTry = [preferredModel, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'].filter((m, i, arr) => m && arr.indexOf(m) === i);
      let resp = null, usedModel = '', lastErr = null;
      if(apiKey){
        for(const m of modelsToTry){
          try{
            const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
              method: 'POST',
              headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: instructions }] },
                contents,
                generationConfig: { maxOutputTokens: 1000 }
              }),
              signal: AbortSignal.timeout(20000)
            });
            if(r.ok){ resp = r; usedModel = m; break; }
            lastErr = r;
            if(r.status === 401 || r.status === 403) break;
          }catch(err){ lastErr = err; }
        }
      }
      const calcSmartDelay = (text) => {
        if(cfg.aiSmartTiming === false){
          const min = Number(cfg.aiMinDelay) || 15, max = Math.max(min, Number(cfg.aiMaxDelay) || 45);
          return { minSeconds: min, maxSeconds: max, simulatedDelaySeconds: Math.floor(Math.random() * (max - min + 1)) + min };
        }
        const readingSec = Math.min(4, Math.max(1.5, (userMessage.length / 50) + 1));
        const typingSec = Math.max(2, ((text?.length || 60) / 32));
        const min = Math.max(2, Number(cfg.aiMinDelay) || 3), max = Math.max(min, Number(cfg.aiMaxDelay) || 25);
        const simulatedDelaySeconds = Math.min(max, Math.max(min, Math.round(readingSec + typingSec)));
        return { minSeconds: min, maxSeconds: max, simulatedDelaySeconds };
      };
      if(resp && resp.ok){
        const resData = await resp.json();
        const text = (resData.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
        if(text){
          const t = calcSmartDelay(text);
          return json({ success: true, reply: text, model: usedModel, smartTiming: cfg.aiSmartTiming !== false, ...t });
        }
      }
      const fallbackText = generateSmartDelivaleReply(userMessage, data.history, instructions, cfg, data.company || 'Restaurante Exemplo');
      const t = calcSmartDelay(fallbackText);
      return json({
        success: true,
        reply: fallbackText,
        model: apiKey ? 'Delivale AI Engine (Modo Resiliente)' : 'Delivale AI Engine (Simulação)',
        notice: apiKey ? 'Modelo externo indisponível no momento. Resposta gerada pelo motor inteligente Delivale.' : 'Simulação de atendimento com o motor inteligente Delivale ativa.',
        smartTiming: cfg.aiSmartTiming !== false,
        ...t
      });
    }

    if(url.pathname === '/api/gemini/test' && request.method === 'POST'){
      const apiKey = await configuredApiKey(env);
      if(!apiKey) return json({ error: 'Nenhuma chave da API Gemini salva no servidor.' }, 400);
      const modelsToTry = [env.GEMINI_MODEL || 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'].filter(Boolean);
      const start = Date.now();
      let resp = null, usedModel = '', lastErr = null;
      for(const m of modelsToTry){
        try{
          const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Responda apenas: OK - Conexao Gemini Ativa.' }] }],
              generationConfig: { maxOutputTokens: 50 }
            }),
            signal: AbortSignal.timeout(15000)
          });
          if(r.ok){ resp = r; usedModel = m; break; }
          lastErr = r;
          if(r.status === 401 || r.status === 403) break;
        }catch(e){ lastErr = e; }
      }
      if(!resp){
        if(lastErr && lastErr.status){
          let failure = {};
          try{ failure = await lastErr.json(); }catch{}
          const reason = failure.error?.details?.find(item => item.reason)?.reason || '';
          const error = lastErr.status === 429 ? 'A quota do Gemini foi atingida.' : (reason === 'API_KEY_INVALID' || lastErr.status === 401 ? 'Chave Gemini inválida ou não reconhecida pelo Google. Confira no Google AI Studio.' : (failure.error?.message || 'O Google recusou a conexão Gemini (HTTP ' + lastErr.status + ').'));
          return json({ error }, 502);
        }
        return json({ error: 'Erro ao conectar com Gemini: ' + (lastErr?.message || 'Tempo limite excedido.') }, 502);
      }
      const data = await resp.json();
      const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(' ').trim();
      const insts = (await statement(env, "SELECT id, name, status, COALESCE(provider,'EVOLUTION_API') AS provider, api_url AS apiUrl FROM instances ORDER BY name").all()).results || [];
      return json({
        success: true,
        model: usedModel,
        durationMs: Date.now() - start,
        reply: text || 'Conexão OK',
        instancesCount: insts.length,
        connectedCount: insts.filter(i => i.status === 'CONNECTED').length,
        instances: insts
      });
    }

    if(url.pathname === '/api/history' && request.method === 'GET'){
      const result = await statement(env, "SELECT s.id, s.company, s.phone, s.message, s.type, s.opened_at AS date, s.status, s.confirmed_at AS confirmedAt, COALESCE(c.city,'') AS city FROM sends s LEFT JOIN contacts c ON (c.phone=s.phone OR c.company=s.company) ORDER BY s.opened_at DESC").all();
      return json({ entries: result.results || [] });
    }

    if(url.pathname === '/api/history' && request.method === 'POST'){
      const data = await requestData(request, 20000);
      if(!data || typeof data.id !== 'string' || !data.id || data.id.length > 100 || typeof data.company !== 'string' || !data.company.trim() || data.company.length > 150 || typeof data.phone !== 'string' || !/^\d{10,15}$/.test(data.phone) || typeof data.message !== 'string' || data.message.length > 10000 || typeof data.type !== 'string' || data.type.length > 100) return json({ error: 'Confira os dados do envio.' }, 400);
      const date = typeof data.date === 'string' && !isNaN(Date.parse(data.date)) ? new Date(data.date).toISOString() : new Date().toISOString();
      const status = data.imported && data.status === 'sent' ? 'sent' : 'opened';
      await statement(env, 'INSERT OR IGNORE INTO sends (id, company, phone, message, type, opened_at, status, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', data.id, data.company, data.phone, data.message, data.type, date, status, status === 'sent' ? date : null).run();
      await statement(env, "UPDATE contacts SET status='SENT', last_sent_at=? WHERE phone=? OR company=?", date, cleanPhone(data.phone), data.company).run();
      return json({ success: true });
    }

    if(url.pathname === '/api/followup/config'){
      const defaultRules = "Você faz follow-up pela Delivale quando o cliente parou de responder. Regras: 1) Seja breve (até 3 linhas), educado e natural, sem parecer robô. 2) Não repita saudação nem se apresente de novo. 3) Retome o último assunto da conversa. 4) Tentativa 1: lembre de forma leve e pergunte se ficou alguma dúvida. Tentativa 2: destaque um benefício relevante ao que o cliente perguntou (ex.: cardápio digital, valor fixo sem taxas extras, impressão automática, QR Code na mesa) e ofereça um teste. Tentativa 3: despedida cordial, avisando que ficamos à disposição. 5) Nunca invente preços ou condições; use apenas o que está cadastrado. 6) Se o cliente já recusou ou pediu para parar, não envie. 7) Use no máximo um emoji. 8) Termine com uma pergunta simples.";
      const defaultConfig = { enabled: false, maxAttempts: 3, attempts: [{ attempt: 1, interval: 30, unit: 'minutes' }, { attempt: 2, interval: 4, unit: 'hours' }, { attempt: 3, interval: 24, unit: 'hours' }], windowStart: '08:00', windowEnd: '20:00', timeZone: 'America/Sao_Paulo', stopOnOptout: true, rulesPrompt: defaultRules };
      if(request.method === 'GET'){
        const instName = url.searchParams.get('instance') || '';
        let config = structuredClone(defaultConfig);
        if(instName){
          const row = await statement(env, 'SELECT config_json FROM instance_followup_configs WHERE instance_name=?', instName).first();
          if(row && row.config_json){
            try{ config = { ...defaultConfig, ...JSON.parse(row.config_json) }; }catch{}
          }
        }
        const insts = (await statement(env, "SELECT id, name, status, role FROM instances WHERE role != 'DISPARO' ORDER BY name").all()).results || [];
        return json({ config, instances: insts, defaultRules });
      }
      if(request.method === 'POST'){
        const data = await requestData(request, 50000);
        if(!data.instance) return json({ error: 'Instância não informada.' }, 400);
        const merged = { ...defaultConfig, ...(data.config || {}), updatedAt: new Date().toISOString() };
        const now = new Date().toISOString();
        await statement(env, 'INSERT INTO instance_followup_configs(instance_name, config_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(instance_name) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at', data.instance, JSON.stringify(merged), now).run();
        return json({ success: true, instance: data.instance, config: merged });
      }
    }

    if(url.pathname === '/api/followup/list' && request.method === 'GET'){
      const instName = url.searchParams.get('instance') || '';
      let sql = "SELECT f.*, COALESCE(c.company, f.phone) as company FROM followups f LEFT JOIN contacts c ON (c.phone=f.phone OR c.phone='55'||f.phone)";
      const params = [];
      if(instName){ sql += " WHERE f.instance=?"; params.push(instName); }
      sql += " ORDER BY f.scheduled_at DESC LIMIT 60";
      const rows = (await statement(env, sql, ...params).all()).results || [];
      return json({ followups: rows });
    }

    if(url.pathname === '/api/followup/cancel' && request.method === 'POST'){
      const data = await requestData(request, 10000);
      const now = new Date().toISOString();
      if(data.id){
        await statement(env, "UPDATE followups SET status='cancelled', cancel_reason='cancelled_by_user', updated_at=? WHERE id=? AND status='scheduled'", now, data.id).run();
      } else if(data.instance && data.remoteJid){
        await statement(env, "UPDATE followups SET status='cancelled', cancel_reason='cancelled_by_user', updated_at=? WHERE instance=? AND remote_jid=? AND status='scheduled'", now, data.instance, data.remoteJid).run();
      }
      return json({ success: true });
    }

    if(url.pathname === '/api/followup/preview' && request.method === 'POST'){
      const data = await requestData(request, 20000);
      const testPhone = String(data.phone || '5511999998888').replace(/\D/g, '');
      const contact = await statement(env, "SELECT company FROM contacts WHERE phone=? OR phone=?", testPhone, '55' + testPhone).first();
      const company = contact?.company || 'Cliente Teste';
      const sample = Number(data.attemptNumber) === 1
        ? 'Passando para ver se conseguiu dar uma olhadinha no cardápio digital ou se ficou alguma dúvida sobre o teste gratuito. 😊'
        : (Number(data.attemptNumber) === 2
          ? 'Com a Delivale seus clientes pedem pelo WhatsApp e você economiza 100% de comissões abusivas. Quer testar sem custo por 30 dias?'
          : `Ficamos à disposição caso decida modernizar seus pedidos no futuro. Muito sucesso nas vendas do ${company}! 🤝`);
      return json({ success: true, text: sample, attemptNumber: Number(data.attemptNumber) || 1, company });
    }

    if(url.pathname.startsWith('/api/history/') && request.method === 'PATCH'){
      const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      const now = new Date().toISOString();
      const result = await statement(env, 'UPDATE sends SET status = ?, confirmed_at = ? WHERE id = ?', 'sent', now, id).run();
      const row = await statement(env, 'SELECT company, phone FROM sends WHERE id=?', id).first();
      if(row) await statement(env, "UPDATE contacts SET status='SENT', last_sent_at=? WHERE phone=? OR company=?", now, cleanPhone(row.phone), row.company).run();
      return result.meta?.changes ? json({ success: true }) : json({ error: 'Registro não encontrado.' }, 404);
    }

    return json({ error: 'Método não permitido.' }, 405);
  }catch(error){
    console.error('[Storage Error]', error);
    return json({ error: error.message === 'INPUT_TOO_LARGE' ? 'Reduza o tamanho das informações.' : (error.message || 'O banco de dados está indisponível. Seus campos foram preservados; tente novamente.') }, 500);
  }
}
