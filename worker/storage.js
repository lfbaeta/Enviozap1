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
async function requestData(request,max=75000){const raw=await request.text();if(raw.length>max)throw new Error('INPUT_TOO_LARGE');return JSON.parse(raw)}
function cleanPhone(v){let d=String(v||'').replace(/\D/g,'');if(d.startsWith('0')&&(d.length===11||d.length===12))d=d.slice(1);if(d.length===10||d.length===11)d='55'+d;return d}
function cleanText(v,max=200){return String(v||'').trim().slice(0,max)}
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
 async function handleStorage(request,env,url){
  const central=url.pathname.startsWith('/api/contacts')||url.pathname.startsWith('/api/queue')||url.pathname==='/api/dashboard'||url.pathname==='/api/send-rules'||url.pathname.startsWith('/api/instances')||url.pathname==='/api/ai/test'||url.pathname==='/api/gemini/test'||url.pathname.startsWith('/api/followup');
 if(!central&&!['/api/settings','/api/settings/key','/api/history'].includes(url.pathname)&&!url.pathname.startsWith('/api/history/'))return null;
 if(request.method!=='GET'&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin){
  try{
   const oHost=new URL(request.headers.get('Origin')).host,uHost=new URL(url.origin).host;
   if(oHost!==uHost&&!oHost.endsWith('.run.app')&&!oHost.includes('localhost'))return json({error:'Origem não autorizada.'},403)
  }catch{return json({error:'Origem não autorizada.'},403)}
 }
 try{
  if(url.pathname==='/api/dashboard'&&request.method==='GET'){
   const [agenda,queued,sent,interested,errors]=await Promise.all([
    statement(env,"SELECT COUNT(*) n FROM contacts WHERE status='AGENDA'").first(),
    statement(env,"SELECT COUNT(*) n FROM send_queue WHERE status IN ('QUEUED','PROCESSING')").first(),
    statement(env,"SELECT COUNT(*) n FROM contacts WHERE status='SENT' OR status='INTERESTED'").first(),
    statement(env,"SELECT COUNT(*) n FROM contacts WHERE interested=1").first(),
    statement(env,"SELECT COUNT(*) n FROM send_queue WHERE status='ERROR'").first()
   ]);return json({agenda:agenda?.n||0,queued:queued?.n||0,sent:sent?.n||0,interested:interested?.n||0,errors:errors?.n||0})
  }
  if(url.pathname==='/api/contacts'&&request.method==='GET'){
   const city=cleanText(url.searchParams.get('city')||'',120),status=cleanText(url.searchParams.get('status')||'',30),q=cleanText(url.searchParams.get('q')||'',150);
   let sql='SELECT c.*, (SELECT COUNT(*) FROM contacts c2 WHERE c2.phone=c.phone) AS phone_count FROM contacts c WHERE 1=1',args=[];
   if(city){sql+=' AND c.city=?';args.push(city)}
   if(status){sql+=' AND c.status=?';args.push(status)}
   if(q){sql+=' AND (c.company LIKE ? OR c.phone LIKE ? OR c.city LIKE ? OR c.notes LIKE ?)';args.push('%'+q+'%','%'+q+'%','%'+q+'%','%'+q+'%')}
   sql+=' ORDER BY c.company COLLATE NOCASE';
   const result=await statement(env,sql,...args).all();
   const cities=await statement(env,"SELECT DISTINCT city FROM contacts WHERE city IS NOT NULL AND city != '' ORDER BY city COLLATE NOCASE").all();
   const dupCount=await statement(env,'SELECT COUNT(*) AS n FROM contacts WHERE phone IN (SELECT phone FROM contacts GROUP BY phone HAVING COUNT(*) > 1)').first();
   return json({contacts:result.results||[],cities:(cities.results||[]).map(x=>x.city),duplicateCount:dupCount?.n||0})
  }
  if(url.pathname==='/api/contacts/import'&&request.method==='POST'){
   const data=await requestData(request,1000000);
   const defaultCity=cleanText(data.city||'',120);
   if(!Array.isArray(data.contacts)||!data.contacts.length)return json({error:'Nenhum contato encontrado para importação.'},400);
   let imported=0,duplicates=0,skipped=0;
   const existingRows=(await statement(env,"SELECT phone FROM contacts").all()).results||[];
   const existingPhones=new Set(existingRows.map(x=>x.phone));
   const seenInBatch=new Set();

   for(const item of data.contacts.slice(0,5000)){
     const company=cleanText(item.company||item.estabelecimento||item.name,150);
     const phone=cleanPhone(item.phone||item.whatsapp||item.telefone);
     if(!company||!/^[0-9]{10,15}$/.test(phone)){
       skipped++;
       continue;
     }
     if(existingPhones.has(phone)||seenInBatch.has(phone)){
       duplicates++;
       skipped++;
       continue;
     }
     seenInBatch.add(phone);
     existingPhones.add(phone);
     const rowCity=cleanText(item.city||item.cidade,120)||defaultCity||'Geral';
     const responsible=cleanText(item.responsible||item.responsavel||item.categoria||item.category,150);
     const id=crypto.randomUUID(),now=new Date().toISOString();
     const r=await statement(env,'INSERT OR IGNORE INTO contacts(id,company,responsible,phone,city,notes,status,interested,created_at,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,company,responsible,phone,rowCity,cleanText(item.notes,1000),'AGENDA',0,now,now).run();
     if(r.meta?.changes){
       imported++;
       await event(env,id,'IMPORTED','Cidade: '+rowCity);
     }else{
       skipped++;
     }
   }
   return json({success:true,imported,duplicates,skipped});
  }
  if(url.pathname.match(/^\/api\/contacts\/[^/]+$/)&&request.method==='PATCH'){
   const id=decodeURIComponent(url.pathname.split('/').pop()),data=await requestData(request,10000);const company=cleanText(data.company,150),phone=cleanPhone(data.phone),city=cleanText(data.city,120);if(!company||!city||!/^[0-9]{10,15}$/.test(phone))return json({error:'Confira estabelecimento, WhatsApp e cidade.'},400);
   const r=await statement(env,'UPDATE contacts SET company=?,responsible=?,phone=?,city=?,notes=? WHERE id=?',company,cleanText(data.responsible,150),phone,city,cleanText(data.notes,1000),id).run();if(r.meta?.changes)await event(env,id,'EDITED');return r.meta?.changes?json({success:true}):json({error:'Contato não encontrado.'},404)
  }
  if(url.pathname.match(/^\/api\/contacts\/[^/]+\/interest$/)&&request.method==='PATCH'){
   const id=decodeURIComponent(url.pathname.split('/')[3]),data=await requestData(request,1000),value=data.interested===true;const r=await statement(env,"UPDATE contacts SET interested=?,status=CASE WHEN ?=1 THEN 'INTERESTED' ELSE CASE WHEN last_sent_at IS NULL THEN 'AGENDA' ELSE 'SENT' END END WHERE id=?",value?1:0,value?1:0,id).run();if(r.meta?.changes)await event(env,id,value?'INTERESTED':'INTEREST_REMOVED');return r.meta?.changes?json({success:true}):json({error:'Contato não encontrado.'},404)
  }
  if(url.pathname.match(/^\/api\/contacts\/[^/]+\/return$/)&&request.method==='POST'){
   const id=decodeURIComponent(url.pathname.split('/')[3]);const r=await statement(env,"UPDATE contacts SET status='AGENDA' WHERE id=?",id).run();if(r.meta?.changes)await event(env,id,'RETURNED_TO_AGENDA');return r.meta?.changes?json({success:true}):json({error:'Contato não encontrado.'},404)
  }
  if(url.pathname==='/api/queue'&&request.method==='GET'){const r=await statement(env,"SELECT q.*,c.company,c.phone,c.city,c.interested FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status IN ('QUEUED','PROCESSING','ERROR') ORDER BY q.position,q.created_at").all();return json({entries:r.results||[]})}
  if(url.pathname==='/api/queue'&&request.method==='DELETE'){
   const rows=(await statement(env,"SELECT id,contact_id FROM send_queue WHERE status IN ('QUEUED','ERROR')").all()).results||[];
   for(const row of rows){await statement(env,'DELETE FROM send_queue WHERE id=?',row.id).run();await statement(env,"UPDATE contacts SET status='AGENDA' WHERE id=?",row.contact_id).run();await event(env,row.contact_id,'QUEUE_CLEARED')}
   return json({success:true,cleared:rows.length})
  }
  if(url.pathname==='/api/queue'&&request.method==='POST'){
   const data=await requestData(request,20000),limit=Math.max(1,Math.min(500,Number(data.quantity)||20)),city=cleanText(data.city,120),q=cleanText(data.q,150);
   let contacts=[];
   if(Array.isArray(data.contactIds)&&data.contactIds.length){
     for(const id of data.contactIds.slice(0,500)){
       const c=await statement(env,"SELECT id,company,phone,city,last_sent_at FROM contacts WHERE id=? AND status='AGENDA'",cleanText(id,100)).first();
       if(c)contacts.push(c);
     }
   }else{
     let sql="SELECT id,company,phone,city,last_sent_at FROM contacts WHERE status='AGENDA'",args=[];
     if(city){sql+=' AND city=?';args.push(city)}
     if(q){sql+=' AND (company LIKE ? OR phone LIKE ? OR city LIKE ?)';args.push('%'+q+'%','%'+q+'%','%'+q+'%')}
     sql+=' ORDER BY company COLLATE NOCASE LIMIT ?';
     args.push(limit);
     contacts=(await statement(env,sql,...args).all()).results||[];
   }
   const settings=await savedSettings(env);
   const cfg=settings?JSON.parse(settings.config_json):{};
   const type=TEMPLATE_KEYS.includes(data.type)?data.type:'initial';
   const mode=data.mode==='AI'?'AI':'STANDARD';
   const tmpl=cfg.templates?.[type]||'Olá {empresa}!';

   let added=0;
   const pos=await statement(env,'SELECT COALESCE(MAX(position),0) n FROM send_queue').first();
   let position=Number(pos?.n||0);
   for(const c of contacts){
     if(c.last_sent_at&&!data.allowResend)continue;
     const id=crypto.randomUUID();
     let message=parseSpintax(String(tmpl).replaceAll('{empresa}',c.company||'').replaceAll('{telefone}',c.phone||''));
     if(mode==='AI')message='[IA] '+message;
     const msgPayload=JSON.stringify({mode,type,text:message});
     try{
       await statement(env,"INSERT INTO send_queue(id,contact_id,status,message,position,created_at) VALUES(?,?,'QUEUED',?,?,?)",id,c.id,msgPayload,++position,new Date().toISOString()).run();
       await statement(env,"UPDATE contacts SET status='QUEUED' WHERE id=?",c.id).run();
       await event(env,c.id,'QUEUED');
       added++;
     }catch{}
   }
   return json({success:true,added});
  }
  if(url.pathname==='/api/queue/prepare'&&request.method==='POST'){const data=await requestData(request,10000),type=TEMPLATE_KEYS.includes(data.type)?data.type:'initial',mode=data.mode==='AI'?'AI':'STANDARD',settings=await savedSettings(env);if(!settings)return json({error:'Configure as mensagens primeiro.'},409);const config=JSON.parse(settings.config_json),rows=(await statement(env,"SELECT q.id,c.company,c.phone FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status='QUEUED' ORDER BY q.position").all()).results||[];let prepared=0;for(const row of rows){let message=parseSpintax(String(config.templates?.[type]||'').replaceAll('{empresa}',row.company||'').replaceAll('{telefone}',row.phone||''));if(mode==='AI')message='[IA] '+message;await statement(env,'UPDATE send_queue SET message=? WHERE id=?',JSON.stringify({mode,type,text:message}),row.id).run();prepared++}return json({success:true,prepared,mode,type})}
  if(url.pathname.match(/^\/api\/queue\/[^/]+$/)&&request.method==='DELETE'){const id=decodeURIComponent(url.pathname.split('/').pop());const row=await statement(env,'SELECT contact_id FROM send_queue WHERE id=? AND status=?',id,'QUEUED').first();if(!row)return json({error:'Item não pode ser removido.'},409);await statement(env,'DELETE FROM send_queue WHERE id=?',id).run();await statement(env,"UPDATE contacts SET status='AGENDA' WHERE id=?",row.contact_id).run();await event(env,row.contact_id,'QUEUE_REMOVED');return json({success:true})}
  if(url.pathname==='/api/queue/control'&&request.method==='POST'){
   const d=await requestData(request,2000),action=String(d.action||'').toUpperCase(),map={START:'RUNNING',RESUME:'RUNNING',PAUSE:'PAUSED',STOP:'STOPPED'};
   if(!map[action])return json({error:'Ação inválida.'},400);
   if(action==='START'||action==='RESUME'){
     await statement(env,"UPDATE send_queue SET status='QUEUED',error=NULL WHERE status='ERROR'").run();
     const queued=await statement(env,"SELECT COUNT(*) n FROM send_queue WHERE status='QUEUED'").first();
     if(!(queued?.n>0))return json({error:'Não há contatos aguardando envio.'},409);
     const connected=await statement(env,"SELECT COUNT(*) n FROM instances WHERE status='CONNECTED'").first();
     if(!(connected?.n>0))return json({error:'Conecte pelo menos uma instância antes de iniciar.'},409);
     const settings=await savedSettings(env);
     if(settings){
       const cfg=JSON.parse(settings.config_json);
       const unmsg=(await statement(env,"SELECT q.id,c.company,c.phone FROM send_queue q JOIN contacts c ON c.id=q.contact_id WHERE q.status='QUEUED' AND (q.message IS NULL OR q.message='')").all()).results||[];
       for(const u of unmsg){
         const text=parseSpintax(String(cfg.templates?.initial||'Olá {empresa}!').replaceAll('{empresa}',u.company||'').replaceAll('{telefone}',u.phone||''));
         await statement(env,'UPDATE send_queue SET message=? WHERE id=?',JSON.stringify({mode:'STANDARD',type:'initial',text}),u.id).run();
       }
     }
     const now=new Date().toISOString();
     await statement(env,'UPDATE send_rules SET queue_state=?,next_send_at=?,last_error=NULL,updated_at=? WHERE id=1',map[action],now,now).run();
   }else{
     await statement(env,'UPDATE send_rules SET queue_state=?,next_send_at=NULL,updated_at=? WHERE id=1',map[action],new Date().toISOString()).run();
   }
   const message=map[action]==='RUNNING'?'Fila iniciada.':map[action]==='PAUSED'?'Fila pausada.':'Fila parada.';
   return json({success:true,state:map[action],message});
  }
  if(url.pathname==='/api/send-rules'){
   if(request.method==='GET'){const r=await statement(env,'SELECT * FROM send_rules WHERE id=1').first();let remainingSeconds=null;if(r?.queue_state==='RUNNING'&&r?.next_send_at){remainingSeconds=Math.max(0,Math.ceil((new Date(r.next_send_at).getTime()-Date.now())/1000))}return json({rules:{...r,remainingSeconds}})}
   if(request.method==='PUT'){const d=await requestData(request,5000),min=Math.max(1,Number(d.minSeconds)||60),max=Math.max(min,Number(d.maxSeconds)||180),cycle=Math.max(1,Number(d.messagesPerCycle)||10),rest=Math.max(0,Number(d.restMinutes)||20),sw=Math.max(1,Number(d.switchAfter)||10);await statement(env,'UPDATE send_rules SET min_seconds=?,max_seconds=?,messages_per_cycle=?,rest_minutes=?,switch_after=?,updated_at=? WHERE id=1',min,max,cycle,rest,sw,new Date().toISOString()).run();return json({success:true})}
  }
  if(url.pathname==='/api/instances'&&request.method==='GET'){const r=await statement(env,"SELECT id,name,status,COALESCE(provider,'EVOLUTION_API') AS provider,api_url AS apiUrl,last_checked_at AS lastCheckedAt,rest_until AS restUntil,sent_in_cycle AS sentInCycle,min_seconds AS minSeconds,max_seconds AS maxSeconds,messages_per_cycle AS messagesPerCycle,rest_minutes AS restMinutes,COALESCE(role,'ALL') AS role FROM instances ORDER BY name").all();return json({instances:r.results||[]})}
  if(url.pathname.startsWith('/api/instances/')&&request.method==='DELETE'){const id=decodeURIComponent(url.pathname.slice('/api/instances/'.length));await statement(env,'DELETE FROM instances WHERE id=?',id).run();return json({success:true})}
  if(url.pathname==='/api/instances'&&request.method==='POST'){const d=await requestData(request,7000),provider=d.provider==='EVOLUTION_GO'?'EVOLUTION_GO':'EVOLUTION_API',name=cleanText(d.name,100),apiUrl=cleanText(d.apiUrl,500).replace(/\/$/,'');const token=String(d.token||'').trim(),role=['ALL','DISPARO','IA'].includes(d.role)?d.role:'ALL',minSeconds=Math.max(1,Number(d.minSeconds)||60),maxSeconds=Math.max(minSeconds,Number(d.maxSeconds)||180),messagesPerCycle=Math.max(1,Number(d.messagesPerCycle)||10),restMinutes=Math.max(0,Number(d.restMinutes)||20);if(!name||!apiUrl||!token)return json({error:'Informe serviço, nome, URL e API Key.'},400);const instanceToken=provider==='EVOLUTION_GO'?Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''):'';const id=crypto.randomUUID(),now=new Date().toISOString();await statement(env,"INSERT INTO instances(id,name,status,provider,api_url,token_cipher,instance_token_cipher,min_seconds,max_seconds,messages_per_cycle,rest_minutes,role,created_at,updated_at) VALUES(?,?,'DISCONNECTED',?,?,?,?,?,?,?,?,?,?,?)",id,name,provider,apiUrl,await encryptSecret(token,env),instanceToken?await encryptSecret(instanceToken,env):null,minSeconds,maxSeconds,messagesPerCycle,restMinutes,role,now,now).run();return json({success:true,id})}
  if(url.pathname.match(/^\/api\/instances\/[^/]+$/)&&request.method==='PATCH'){const id=decodeURIComponent(url.pathname.split('/')[3]),row=await statement(env,'SELECT * FROM instances WHERE id=?',id).first();if(!row)return json({error:'Instância não encontrada.'},404);const d=await requestData(request,7000),provider=d.provider==='EVOLUTION_GO'?'EVOLUTION_GO':'EVOLUTION_API',name=cleanText(d.name,100),apiUrl=cleanText(d.apiUrl,500).replace(/\/$/,'');const token=String(d.token||'').trim(),role=['ALL','DISPARO','IA'].includes(d.role)?d.role:(row.role||'ALL'),minSeconds=Math.max(1,Number(d.minSeconds)||row.min_seconds||60),maxSeconds=Math.max(minSeconds,Number(d.maxSeconds)||row.max_seconds||180),messagesPerCycle=Math.max(1,Number(d.messagesPerCycle)||row.messages_per_cycle||10),restMinutes=Math.max(0,Number(d.restMinutes)??row.rest_minutes??20);if(!name||!apiUrl)return json({error:'Informe serviço, nome e URL.'},400);let tokenCipher=row.token_cipher,instanceTokenCipher=row.instance_token_cipher;if(token)tokenCipher=await encryptSecret(token,env);if(provider==='EVOLUTION_GO'&&!instanceTokenCipher){const generated=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');instanceTokenCipher=await encryptSecret(generated,env)}await statement(env,"UPDATE instances SET name=?,provider=?,api_url=?,token_cipher=?,instance_token_cipher=?,min_seconds=?,max_seconds=?,messages_per_cycle=?,rest_minutes=?,role=?,status='DISCONNECTED',updated_at=? WHERE id=?",name,provider,apiUrl,tokenCipher,instanceTokenCipher,minSeconds,maxSeconds,messagesPerCycle,restMinutes,role,new Date().toISOString(),id).run();return json({success:true})}
  if(url.pathname.match(/^\/api\/instances\/[^/]+\/(connect|status)$/)&&request.method==='POST'){
   const parts=url.pathname.split('/'),id=decodeURIComponent(parts[3]),action=parts[4];const row=await statement(env,'SELECT * FROM instances WHERE id=?',id).first();if(!row)return json({error:'Instância não encontrada.'},404);if(!row.api_url||!row.token_cipher)return json({error:'Configure URL e API Key.'},400);
   let globalToken,instanceToken='';try{globalToken=await decryptSecret(row.token_cipher,env);if(row.instance_token_cipher)instanceToken=await decryptSecret(row.instance_token_cipher,env)}catch{return json({error:'Não foi possível abrir as credenciais salvas.'},503)}
   const provider=row.provider||'EVOLUTION_API',base=String(row.api_url).replace(/\/$/,'');const call=async(path,key,options={})=>{const resp=await fetch(base+path,{...options,headers:{'Content-Type':'application/json','apikey':key,...(options.headers||{})},signal:AbortSignal.timeout(20000)});let data={};try{data=await resp.json()}catch{}return {ok:resp.ok,status:resp.status,data}};
   const configureWebhook=async()=>{try{const webhookUrl=url.origin+'/api/webhook';if(provider==='EVOLUTION_GO'){await call('/webhook',instanceToken||globalToken,{method:'POST',body:JSON.stringify({enabled:true,url:webhookUrl,events:['messages.upsert','messages','presence.update','send.message','connection.update']})})}else{await call('/webhook/set/'+encodeURIComponent(row.name),globalToken,{method:'POST',body:JSON.stringify({webhook:{enabled:true,url:webhookUrl,byEvents:false,base64:false,events:['MESSAGES_UPSERT','SEND_MESSAGE','CONNECTION_UPDATE']},enabled:true,url:webhookUrl,webhookByEvents:false,events:['MESSAGES_UPSERT','messages.upsert','SEND_MESSAGE','send.message','CONNECTION_UPDATE','connection.update']})})}}catch{}};
   if(provider==='EVOLUTION_GO'){
    if(!instanceToken)return json({error:'Token da instância Evolution GO não configurado.'},400);
    if(action==='status'){const r=await call('/instance/status',instanceToken);const connected=!!(r.data?.data?.loggedIn??r.data?.loggedIn??r.data?.data?.connected??r.data?.connected);await statement(env,'UPDATE instances SET status=?,last_checked_at=?,updated_at=? WHERE id=?',connected?'CONNECTED':'DISCONNECTED',new Date().toISOString(),new Date().toISOString(),id).run();if(connected)await configureWebhook();if(!r.ok)return json({error:r.data?.message||'Não foi possível consultar a Evolution GO.'},502);return json({success:true,connected})}
    const created=await call('/instance/create',globalToken,{method:'POST',body:JSON.stringify({name:row.name,token:instanceToken})});if(!created.ok&&![400,409,422].includes(created.status))return json({error:created.data?.message||'Falha ao criar a instância na Evolution GO.'},502);
    const connected=await call('/instance/connect',instanceToken,{method:'POST',body:'{}'});if(!connected.ok&&![400,409,422].includes(connected.status))return json({error:connected.data?.message||'Falha ao iniciar conexão na Evolution GO.'},502);
    await configureWebhook();
    await new Promise(r=>setTimeout(r,800));const qrRes=await call('/instance/qr',instanceToken);if(!qrRes.ok)return json({error:qrRes.data?.message||'Evolution GO não retornou o QR Code.'},502);const qr=qrRes.data?.data?.code||qrRes.data?.code||qrRes.data?.data?.qrcode||qrRes.data?.qrcode||null;return json({success:true,connected:false,qr})
   }
   if(action==='status'){const r=await call('/instance/connectionState/'+encodeURIComponent(row.name),globalToken);const state=String(r.data?.instance?.state||r.data?.state||'').toLowerCase(),connected=state==='open'||state==='connected';await statement(env,'UPDATE instances SET status=?,last_checked_at=?,updated_at=? WHERE id=?',connected?'CONNECTED':'DISCONNECTED',new Date().toISOString(),new Date().toISOString(),id).run();if(connected)await configureWebhook();if(!r.ok)return json({error:r.data?.message||'Não foi possível consultar a Evolution API.'},502);return json({success:true,connected,state})}
   const created=await call('/instance/create',globalToken,{method:'POST',body:JSON.stringify({instanceName:row.name,qrcode:true,integration:'WHATSAPP-BAILEYS'})});if(!created.ok&&![400,403,409,422].includes(created.status))return json({error:created.data?.message||'Falha ao criar a instância na Evolution API.'},502);
   await configureWebhook();
   const conn=await call('/instance/connect/'+encodeURIComponent(row.name),globalToken);if(!conn.ok)return json({error:conn.data?.message||'A Evolution API não retornou o QR Code.'},502);const qr=conn.data?.base64||conn.data?.qrcode?.base64||conn.data?.qr||conn.data?.code||created.data?.qrcode?.base64||created.data?.base64||null;return json({success:true,connected:false,qr})
  }
  if(url.pathname==='/api/settings/key'){
   if(request.method!=='PUT')return json({error:'Método não permitido.'},405);
   const data=await requestData(request,2500);const key=normalizeApiKey(data?.apiKey);if(!key||key.length>512)return json({error:'Insira a chave Gemini antes de salvar.'},400);
   const row=await savedSettings(env);if(!row)return json({error:'Aguarde as configurações carregarem e tente novamente.'},409);
   await statement(env,'UPDATE settings SET key_cipher = ?, updated_at = ? WHERE id = ?',await encryptSecret(key,env),new Date().toISOString(),1).run();return json({hasApiKey:true})
  }
  if(url.pathname==='/api/settings'){
   if(request.method==='GET'){
     const row=await savedSettings(env);
     const insts=(await statement(env,"SELECT id,name,status,COALESCE(provider,'EVOLUTION_API') AS provider,api_url AS apiUrl,COALESCE(role,'ALL') AS role FROM instances ORDER BY name").all()).results||[];
     let pausedCount=0;
     try{const pc=await statement(env,"SELECT COUNT(*) n FROM ai_human_interventions WHERE datetime(paused_until) > datetime('now')").first();pausedCount=pc?.n||0}catch{}
     return json({
       config:row?JSON.parse(row.config_json):null,
       hasApiKey:!!(row?.key_cipher||env.GEMINI_API_KEY),
       instancesCount:insts.length,
       connectedCount:insts.filter(i=>i.status==='CONNECTED').length,
       instances:insts,
       pausedCount
     });
   }
   if(request.method!=='PUT')return json({error:'Método não permitido.'},405);
   const data=await requestData(request);if(!validConfig(data.config))return json({error:'Confira a oferta, opções e os cinco modelos de mensagem.'},400);
   const row=await savedSettings(env);if(data.initializeOnly&&row)return json({config:JSON.parse(row.config_json),hasApiKey:!!(row.key_cipher||env.GEMINI_API_KEY)});
   let cipher=row?.key_cipher||null;if(data.removeApiKey===true)cipher=null;else if(data.apiKey){const key=normalizeApiKey(data.apiKey);if(!key||key.length>512)return json({error:'Confira a chave Gemini inserida.'},400);cipher=await encryptSecret(key,env)}
   const operation=data.initializeOnly?'INSERT OR IGNORE INTO settings (id,config_json,key_cipher,updated_at) VALUES (?,?,?,?)':'INSERT INTO settings (id,config_json,key_cipher,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,key_cipher=excluded.key_cipher,updated_at=excluded.updated_at';
   await statement(env,operation,1,JSON.stringify(data.config),cipher,new Date().toISOString()).run();const updated=await savedSettings(env);return json({config:JSON.parse(updated.config_json),hasApiKey:!!(updated.key_cipher||env.GEMINI_API_KEY)})
  }
  if(url.pathname==='/api/ai/toggle'&&(request.method==='POST'||request.method==='PUT')){
    const body=await requestData(request,5000);
    const row=await savedSettings(env);
    if(!row)return json({error:'Configurações não encontradas.'},404);
    const cfg=JSON.parse(row.config_json);
    cfg.aiEnabled = typeof body.enabled==='boolean' ? body.enabled : !cfg.aiEnabled;
    await statement(env,'UPDATE settings SET config_json=?,updated_at=? WHERE id=1',JSON.stringify(cfg),new Date().toISOString()).run();
    return json({success:true,aiEnabled:cfg.aiEnabled});
  }
  if(url.pathname==='/api/ai/test'&&request.method==='POST'){
   const data=await requestData(request,25000);
   const userMessage=cleanText(data.message||data.userMessage||'',1500);
   if(!userMessage)return json({error:'Digite uma mensagem para testar a IA.'},400);
   const settings=await savedSettings(env);
   if(!settings)return json({error:'Configurações não encontradas.'},404);
   const cfg=JSON.parse(settings.config_json);
   const apiKey=await configuredApiKey(env);


   let instructions=cleanText(data.customPrompt||cfg.aiPrompt||'',15000);
   if(instructions.trim()){
     instructions=instructions
       .replaceAll('{empresa}',data.company||'Restaurante Exemplo')
       .replaceAll('{oferta}',cfg.offer||'')
       .replaceAll('{cadastro}',cfg.aiRegistration||'')
       .replaceAll('{handoff}',cfg.aiHandoff||'')
       .replaceAll('{instrucoes}',cfg.aiInstructions||'');
   }else{
     instructions=`Você é a atendente virtual e especialista de vendas da Delivale.com no WhatsApp conversando diretamente com o cliente (${data.company||'Restaurante Exemplo'}).
Como explicar o serviço:
${cfg.aiInstructions||'A Delivale é um portal de pedidos e cardápio digital para delivery com 30 dias grátis.'}

Dados que devem ser solicitados:
${cfg.aiRegistration||'Nome, WhatsApp, cidade e segmento.'}

Mensagem de conclusão:
${cfg.aiHandoff||'Agradeça e informe os próximos passos.'}

Oferta cadastrada:
${cfg.offer||''}

Responda em português do Brasil de forma amigável, clara, empática e objetiva. Responda apenas o texto da mensagem a ser enviada no WhatsApp.`;
   }

   const contents=[];
   if(Array.isArray(data.history)&&data.history.length>0){
     for(const h of data.history.slice(-8)){
       const role=h.role==='model'?'model':'user';
       const txt=cleanText(h.text||h.content||'',1000);
       if(!txt)continue;
       if(contents.length&&contents[contents.length-1].role===role){
         contents[contents.length-1].parts[0].text+='\n'+txt;
       }else{
         contents.push({role,parts:[{text:txt}]});
       }
     }
   }
   if(contents.length===0||contents[contents.length-1].role!=='user'){
     contents.push({role:'user',parts:[{text:userMessage}]});
   }

   const preferredModel=cleanText(data.model||cfg.aiModel||env.GEMINI_MODEL||'gemini-2.5-flash',50);
   const modelsToTry=[preferredModel,'gemini-2.5-flash','gemini-flash-latest','gemini-3.1-flash-lite'].filter((m,i,arr)=>m&&arr.indexOf(m)===i);
   let resp=null,usedModel='',lastErr=null;
   if(apiKey){
     for(const m of modelsToTry){
       try{
         const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent',{
           method:'POST',
           headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},
           body:JSON.stringify({
             systemInstruction:{parts:[{text:instructions}]},
             contents,
             generationConfig:{maxOutputTokens:1000}
           }),
           signal:AbortSignal.timeout(20000)
         });
         if(r.ok){resp=r;usedModel=m;break}
         lastErr=r;
         if(r.status===401||r.status===403)break;
       }catch(err){lastErr=err}
     }
   }
    const calcSmartDelay=(text)=>{
      if(cfg.aiSmartTiming===false){
        const min=Number(cfg.aiMinDelay)||15,max=Math.max(min,Number(cfg.aiMaxDelay)||45);
        return {minSeconds:min,maxSeconds:max,simulatedDelaySeconds:Math.floor(Math.random()*(max-min+1))+min};
      }
      const readingSec=Math.min(4,Math.max(1.5,(userMessage.length/50)+1));
      const typingSec=Math.max(2,((text?.length||60)/32));
      const min=Math.max(2,Number(cfg.aiMinDelay)||3),max=Math.max(min,Number(cfg.aiMaxDelay)||25);
      const simulatedDelaySeconds=Math.min(max,Math.max(min,Math.round(readingSec+typingSec)));
      return {minSeconds:min,maxSeconds:max,simulatedDelaySeconds};
    };
    if(resp&&resp.ok){
      const resData=await resp.json();
      const text=(resData.candidates?.[0]?.content?.parts||[]).filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join('\n').trim();
      if(text){
        const t=calcSmartDelay(text);
        return json({success:true,reply:text,model:usedModel,smartTiming:cfg.aiSmartTiming!==false,...t});
      }
    }
    const fallbackText=generateSmartDelivaleReply(userMessage,data.history,instructions,cfg,data.company||'Restaurante Exemplo');
    const t=calcSmartDelay(fallbackText);
    return json({
      success:true,
      reply:fallbackText,
      model:apiKey?'Delivale AI Engine (Modo Resiliente)':'Delivale AI Engine (Simulação)',
      notice:apiKey?'Modelo externo indisponível no momento. Resposta gerada pelo motor inteligente Delivale.':'Simulação de atendimento com o motor inteligente Delivale ativa.',
      smartTiming:cfg.aiSmartTiming!==false,
      ...t
    });
  }
  if(url.pathname==='/api/gemini/test'&&request.method==='POST'){
   const apiKey=await configuredApiKey(env);
   if(!apiKey)return json({error:'Nenhuma chave da API Gemini salva no servidor.'},400);
   const modelsToTry=[env.GEMINI_MODEL||'gemini-2.5-flash','gemini-flash-latest','gemini-3.1-flash-lite'].filter(Boolean);
   const start=Date.now();
   let resp=null,usedModel='',lastErr=null;
   for(const m of modelsToTry){
     try{
       const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent',{
         method:'POST',
         headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},
         body:JSON.stringify({
           contents:[{role:'user',parts:[{text:'Responda apenas: OK - Conexao Gemini Ativa.'}]}],
           generationConfig:{maxOutputTokens:50}
         }),
         signal:AbortSignal.timeout(15000)
       });
       if(r.ok){resp=r;usedModel=m;break}
       lastErr=r;
       if(r.status===401||r.status===403)break;
     }catch(e){lastErr=e}
   }
   if(!resp){
     if(lastErr&&lastErr.status){
       let failure={};try{failure=await lastErr.json()}catch{}
       const reason=failure.error?.details?.find(item=>item.reason)?.reason||'';
       const error=lastErr.status===429?'A quota do Gemini foi atingida.':(reason==='API_KEY_INVALID'||lastErr.status===401?'Chave Gemini inválida ou não reconhecida pelo Google. Confira no Google AI Studio.':(failure.error?.message||'O Google recusou a conexão Gemini (HTTP '+lastErr.status+').'));
       return json({error},502);
     }
     return json({error:'Erro ao conectar com Gemini: '+(lastErr?.message||'Tempo limite excedido.')},502);
   }
   const data=await resp.json();
   const text=(data.candidates?.[0]?.content?.parts||[]).filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join(' ').trim();
   const insts=(await statement(env,"SELECT id,name,status,COALESCE(provider,'EVOLUTION_API') AS provider,api_url AS apiUrl FROM instances ORDER BY name").all()).results||[];
   return json({
       success:true,
       model:usedModel,
       durationMs:Date.now()-start,
       reply:text||'Conexão OK',
       instancesCount:insts.length,
       connectedCount:insts.filter(i=>i.status==='CONNECTED').length,
       instances:insts
     });
  }
  if(url.pathname==='/api/history'&&request.method==='GET'){const result=await statement(env,"SELECT s.id,s.company,s.phone,s.message,s.type,s.opened_at AS date,s.status,s.confirmed_at AS confirmedAt,COALESCE(c.city,'') AS city FROM sends s LEFT JOIN contacts c ON (c.phone=s.phone OR c.company=s.company) ORDER BY s.opened_at DESC").all();return json({entries:result.results||[]})}
  if(url.pathname==='/api/history'&&request.method==='POST'){const data=await requestData(request,20000);if(!data||typeof data.id!=='string'||!data.id||data.id.length>100||typeof data.company!=='string'||!data.company.trim()||data.company.length>150||typeof data.phone!=='string'||!/^\d{10,15}$/.test(data.phone)||typeof data.message!=='string'||data.message.length>10000||typeof data.type!=='string'||data.type.length>100)return json({error:'Confira os dados do envio.'},400);
   const date=typeof data.date==='string'&&!isNaN(Date.parse(data.date))?new Date(data.date).toISOString():new Date().toISOString();const status=data.imported&&data.status==='sent'?'sent':'opened';
   await statement(env,'INSERT OR IGNORE INTO sends (id,company,phone,message,type,opened_at,status,confirmed_at) VALUES (?,?,?,?,?,?,?,?)',data.id,data.company,data.phone,data.message,data.type,date,status,status==='sent'?date:null).run();
   await statement(env,"UPDATE contacts SET status='SENT',last_sent_at=? WHERE phone=? OR company=?",date,cleanPhone(data.phone),data.company).run();
   return json({success:true})
  }
  if(url.pathname==='/api/followup/config'){
    const defaultRules="Você faz follow-up pela Delivale quando o cliente parou de responder. Regras: 1) Seja breve (até 3 linhas), educado e natural, sem parecer robô. 2) Não repita saudação nem se apresente de novo. 3) Retome o último assunto da conversa. 4) Tentativa 1: lembre de forma leve e pergunte se ficou alguma dúvida. Tentativa 2: destaque um benefício relevante ao que o cliente perguntou (ex.: cardápio digital, valor fixo sem taxas extras, impressão automática, QR Code na mesa) e ofereça um teste. Tentativa 3: despedida cordial, avisando que ficamos à disposição. 5) Nunca invente preços ou condições; use apenas o que está cadastrado. 6) Se o cliente já recusou ou pediu para parar, não envie. 7) Use no máximo um emoji. 8) Termine com uma pergunta simples.";
    const defaultConfig={enabled:false,maxAttempts:3,attempts:[{attempt:1,interval:30,unit:'minutes'},{attempt:2,interval:4,unit:'hours'},{attempt:3,interval:24,unit:'hours'}],windowStart:'08:00',windowEnd:'20:00',timeZone:'America/Sao_Paulo',stopOnOptout:true,rulesPrompt:defaultRules};
    if(request.method==='GET'){
      const instName=url.searchParams.get('instance')||'';
      let config=structuredClone(defaultConfig);
      if(instName){
        const row=await statement(env,'SELECT config_json FROM instance_followup_configs WHERE instance_name=?',instName).first();
        if(row&&row.config_json){
          try{config={...defaultConfig,...JSON.parse(row.config_json)};}catch{}
        }
      }
      const insts=(await statement(env,"SELECT id, name, status, role FROM instances WHERE role != 'DISPARO' ORDER BY name").all()).results||[];
      return json({config,instances:insts,defaultRules});
    }
    if(request.method==='POST'){
      const data=await requestData(request,50000);
      if(!data.instance)return json({error:'Instância não informada.'},400);
      const merged={...defaultConfig,...(data.config||{}),updatedAt:new Date().toISOString()};
      const now=new Date().toISOString();
      await statement(env,'INSERT INTO instance_followup_configs(instance_name,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(instance_name) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at',data.instance,JSON.stringify(merged),now).run();
      return json({success:true,instance:data.instance,config:merged});
    }
  }
  if(url.pathname==='/api/followup/list'&&request.method==='GET'){
    const instName=url.searchParams.get('instance')||'';
    let sql="SELECT f.*, COALESCE(c.company, f.phone) as company FROM followups f LEFT JOIN contacts c ON (c.phone=f.phone OR c.phone='55'||f.phone)";
    const params=[];
    if(instName){sql+=" WHERE f.instance=?";params.push(instName);}
    sql+=" ORDER BY f.scheduled_at DESC LIMIT 60";
    const rows=(await statement(env,sql,...params).all()).results||[];
    return json({followups:rows});
  }
  if(url.pathname==='/api/followup/cancel'&&request.method==='POST'){
    const data=await requestData(request,10000);
    const now=new Date().toISOString();
    if(data.id){
      await statement(env,"UPDATE followups SET status='cancelled', cancel_reason='cancelled_by_user', updated_at=? WHERE id=? AND status='scheduled'",now,data.id).run();
    }else if(data.instance&&data.remoteJid){
      await statement(env,"UPDATE followups SET status='cancelled', cancel_reason='cancelled_by_user', updated_at=? WHERE instance=? AND remote_jid=? AND status='scheduled'",now,data.instance,data.remoteJid).run();
    }
    return json({success:true});
  }
  if(url.pathname==='/api/followup/preview'&&request.method==='POST'){
    const data=await requestData(request,20000);
    const testPhone=String(data.phone||'5511999998888').replace(/\D/g,'');
    const contact=await statement(env,"SELECT company FROM contacts WHERE phone=? OR phone=?",testPhone,'55'+testPhone).first();
    const company=contact?.company||'Cliente Teste';
    const sample=Number(data.attemptNumber)===1
      ?'Passando para ver se conseguiu dar uma olhadinha no cardápio digital ou se ficou alguma dúvida sobre o teste gratuito. 😊'
      :(Number(data.attemptNumber)===2
        ?'Com a Delivale seus clientes pedem pelo WhatsApp e você economiza 100% de comissões abusivas. Quer testar sem custo por 30 dias?'
        :`Ficamos à disposição caso decida modernizar seus pedidos no futuro. Muito sucesso nas vendas do ${company}! 🤝`);
    return json({success:true,text:sample,attemptNumber:Number(data.attemptNumber)||1,company});
  }
  if(url.pathname.startsWith('/api/history/')&&request.method==='PATCH'){const id=decodeURIComponent(url.pathname.slice('/api/history/'.length));const now=new Date().toISOString();const result=await statement(env,'UPDATE sends SET status = ?,confirmed_at = ? WHERE id = ?','sent',now,id).run();const row=await statement(env,'SELECT company,phone FROM sends WHERE id=?',id).first();if(row)await statement(env,"UPDATE contacts SET status='SENT',last_sent_at=? WHERE phone=? OR company=?",now,cleanPhone(row.phone),row.company).run();return result.meta?.changes?json({success:true}):json({error:'Registro não encontrado.'},404)}
  return json({error:'Método não permitido.'},405)
 }catch(error){console.error('[Storage Error]',error);return json({error:error.message==='INPUT_TOO_LARGE'?'Reduza o tamanho das informações.':(error.message||'O banco de dados está indisponível. Seus campos foram preservados; tente novamente.')},500)}
}
