// lib/contacts-utils.mjs

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

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) {
    return { valid: false, reason: 'Telefone não informado' };
  }
  let str = String(raw).trim();
  let digits = str.replace(/\D/g, '');
  if (!digits) {
    return { valid: false, reason: 'Nenhum dígito encontrado' };
  }

  // Remove zeros à esquerda (ex.: 011988887777 ou 005511...)
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
      isMobile = false; // Fixo
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

const CANONICAL_CITIES = {
  'sao paulo': 'São Paulo',
  'pariquera acu': 'Pariquera-Açu',
  'pariquera-acu': 'Pariquera-Açu',
  'registro': 'Registro',
  'iguape': 'Iguape',
  'cananeia': 'Cananéia',
  'ilha comprida': 'Ilha Comprida',
  'jacupiranga': 'Jacupiranga',
  'juquia': 'Juquiá',
  'miracatu': 'Miracatu',
  'sete barras': 'Sete Barras',
  'eldorado': 'Eldorado',
  'rio de janeiro': 'Rio de Janeiro',
  'curitiba': 'Curitiba',
  'santos': 'Santos',
  'campinas': 'Campinas',
  'ribeirao preto': 'Ribeirão Preto',
  'sorocaba': 'Sorocaba'
};

export function normalizeCityName(rawName) {
  if (!rawName) return '';
  let str = String(rawName).trim();
  const unaccented = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/-/g, ' ');
  if (CANONICAL_CITIES[unaccented]) {
    return CANONICAL_CITIES[unaccented];
  }
  return str.split(/\s+/).map(w => {
    if (!w) return '';
    const lower = w.toLowerCase();
    if (['de', 'da', 'do', 'dos', 'das', 'e'].includes(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

export function generateCitySlug(name, state = '') {
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

export function generateCategorySlug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function migrateExistingContacts(db) {
  try {
    const defaultCategories = [
      { id: 'cat-restaurante', name: 'Restaurante', slug: 'restaurante', color: '#ef4444', desc: 'Restaurantes em geral' },
      { id: 'cat-pizzaria', name: 'Pizzaria', slug: 'pizzaria', color: '#f97316', desc: 'Pizzarias e esfiharias' },
      { id: 'cat-lanchonete', name: 'Lanchonete', slug: 'lanchonete', color: '#eab308', desc: 'Lanches e salgados' },
      { id: 'cat-acai', name: 'Açaí', slug: 'acai', color: '#8b5cf6', desc: 'Açaí e sorveterias' },
      { id: 'cat-padaria', name: 'Padaria', slug: 'padaria', color: '#d97706', desc: 'Padarias e confeitarias' },
      { id: 'cat-hamburgueria', name: 'Hamburgueria', slug: 'hamburgueria', color: '#f43f5e', desc: 'Hamburguerias artesanais' },
      { id: 'cat-bar', name: 'Bar', slug: 'bar', color: '#3b82f6', desc: 'Bares e petiscarias' },
      { id: 'cat-outros', name: 'Outros', slug: 'outros', color: '#64748b', desc: 'Demais segmentos alimentícios' }
    ];
    for (const cat of defaultCategories) {
      db.prepare(`
        INSERT OR IGNORE INTO categories (id, name, slug, color, description, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(cat.id, cat.name, cat.slug, cat.color, cat.desc);
    }

    try {
      db.prepare('CREATE TABLE IF NOT EXISTS contacts_backup_20261023 AS SELECT * FROM contacts;').run();
    } catch {}

    const rows = db.prepare('SELECT id, phone, phone_e164, phone_raw, city, city_id, responsible FROM contacts').all();
    const categoriesList = db.prepare('SELECT id, name, slug FROM categories').all();

    for (const row of rows) {
      let needsUpdate = false;
      let newPhoneE164 = row.phone_e164;
      let newPhoneRaw = row.phone_raw || row.phone;
      let newCityId = row.city_id;
      let newCityName = row.city;

      if (!newPhoneE164) {
        const norm = normalizePhone(row.phone);
        if (norm.valid) {
          newPhoneE164 = norm.phone_e164;
          needsUpdate = true;
        } else {
          const clean = String(row.phone).replace(/\D/g, '');
          newPhoneE164 = clean ? (clean.startsWith('55') ? '+' + clean : '+55' + clean) : null;
          needsUpdate = true;
        }
      }

      if (!newCityId && row.city) {
        let rawCity = row.city;
        let detectedCategory = null;
        if (rawCity.includes(' - ')) {
          const parts = rawCity.split(' - ');
          rawCity = parts[0].trim();
          detectedCategory = parts.slice(1).join(' - ').trim();
        }
        const cityName = normalizeCityName(rawCity);
        const slug = generateCitySlug(cityName, '');
        let cityRecord = db.prepare('SELECT id, name FROM cities WHERE slug = ?').get(slug);
        if (!cityRecord) {
          const newId = crypto.randomUUID();
          db.prepare('INSERT INTO cities (id, name, state, slug, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
            .run(newId, cityName, '', slug);
          cityRecord = { id: newId, name: cityName };
        }
        newCityId = cityRecord.id;
        newCityName = cityRecord.name;
        needsUpdate = true;

        if (detectedCategory) {
          const cat = categoriesList.find(c => c.name.toLowerCase() === detectedCategory.toLowerCase() || c.slug === generateCategorySlug(detectedCategory));
          if (cat) {
            try {
              db.prepare('INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)').run(row.id, cat.id);
            } catch {}
          }
        }
      }

      if (row.responsible) {
        const cat = categoriesList.find(c => c.name.toLowerCase() === row.responsible.toLowerCase() || c.slug === generateCategorySlug(row.responsible));
        if (cat) {
          try {
            db.prepare('INSERT OR IGNORE INTO contact_categories (contact_id, category_id) VALUES (?, ?)').run(row.id, cat.id);
          } catch {}
        }
      }

      if (needsUpdate) {
        try {
          db.prepare(`
            UPDATE contacts
            SET phone_e164 = COALESCE(?, phone_e164),
                phone_raw = COALESCE(?, phone_raw),
                city_id = COALESCE(?, city_id),
                city = COALESCE(?, city),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(newPhoneE164, newPhoneRaw, newCityId, newCityName, row.id);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[Contacts Migration Warning]', err.message);
  }
}
