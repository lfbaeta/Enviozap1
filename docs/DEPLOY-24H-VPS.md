# Enviozap1 online 24 horas — VPS Linux

Repositório: https://github.com/lfbaeta/Enviozap1

## O que esta configuração entrega
- Node.js 22.13+ rodando no servidor independente de AI Studio ou do computador do usuário.
- systemd reinicia o processo quando ele termina e o inicia após reinicialização da VPS.
- A fila de mensagens, os webhooks, a sincronização Evolution e o follow-up funcionam **enquanto o processo e suas integrações estão saudáveis**.
- A variável ENABLE_GITHUB_AUTO_SYNC=false evita atualizar código ao vivo a cada 5 segundos. O deploy deve ser manual e testado.

**Limites**: isso não garante zero downtime em quedas da VPS, rede, WhatsApp/Evolution ou Gemini. A API Gemini continua sujeita à própria cota de uso. Monitoramento externo, backup e alertas são necessários.

## Antes de mudar o ambiente ativo
1. Identificar a fonte de dados da instância que **hoje** recebe as mensagens. O arquivo SQLite do servidor é `data.db` no diretório de trabalho. O README antigo fala em D1/backend compartilhado, mas `server.mjs` atualmente usa SQLite local — **não assuma** que as duas instâncias compartilham o banco.
2. Fazer backup do banco, contatos, configuração e chave `SETTINGS_ENCRYPTION_KEY`. Ao migrar, manter a chave original para descriptografar integrações salvas.
3. Conferir DNS, domínio, HTTPS e URL de callback da Evolution API. Não ligar duas cópias do robô com as mesmas instâncias simultaneamente: pode responder em duplicidade.
4. O painel da versão atual pode não exigir login e o webhook não tem autenticação forte visível: **não exponha o serviço diretamente à Internet** sem controle de acesso, proteção de webhook e testes de segurança. Bloqueie a porta 3000 no firewall externo e configure um proxy HTTPS seguro.

## Exemplo para Ubuntu/Debian (VPS limpa)
Confira a versão do Node (22.13 ou superior), git, openssl e systemd antes de executar os comandos abaixo. A instalação do Node e a configuração de proxy HTTPS dependem da VPS e devem ser feitas antes.

```bash
node --version
command -v node
git --version
sudo useradd --system --create-home --home-dir /var/lib/enviozap1 --shell /usr/sbin/nologin enviozap1
sudo install -d -o enviozap1 -g enviozap1 /opt/enviozap1
sudo -u enviozap1 git clone https://github.com/lfbaeta/Enviozap1.git /opt/enviozap1
cd /opt/enviozap1
sudo -u enviozap1 npm ci
sudo install -d -m 700 /etc/enviozap1
sudo nano /etc/enviozap1/enviozap1.env
```

Preencha o arquivo acima com o **valor real**, não publique a chave em GitHub. Exemplo de nomes de variáveis (não copie as linhas com reticências sem substituir):

```dotenv
SETTINGS_ENCRYPTION_KEY=VALOR_ORIGINAL_OU_NOVA_CHAVE_DE_32_BYTES_EM_HEX
GEMINI_API_KEY=SUA_CHAVE_DA_API_SE_UTILIZADA
```

Se ainda não há dados criptografados, gere uma chave segura com `openssl rand -hex 32`; se já há dados, **reuse a chave original**. Não troque a chave depois de ter tokens salvos.

Proteja as variáveis:

```bash
sudo chmod 600 /etc/enviozap1/enviozap1.env
sudo cp /opt/enviozap1/deploy/enviozap1.service /etc/systemd/system/enviozap1.service
sudo systemctl daemon-reload
sudo systemctl enable --now enviozap1
sudo systemctl status enviozap1
sudo journalctl -u enviozap1 -n 100 --no-pager
```

`ExecStart` assume que o Node está em `/usr/bin/node`. Compare com `command -v node` e ajuste o arquivo de serviço, se necessário. `PORT=3000` é interno e não deve ser exposto publicamente.

## Hospedagem pública e eventos Evolution
- Configure Nginx/Caddy como proxy HTTPS para a porta 3000, com domínio próprio e autenticação adequada ao painel.
- O endpoint `POST /api/webhook` recebe eventos. Antes de liberar acesso público a ele, valide sua origem com um segredo próprio ou mecanismo suportado pela Evolution; o `GET /api/webhook` confirma apenas resposta HTTP, não a conexão real ao WhatsApp.
- Revise o webhook de cada instância apontando para o domínio final HTTPS, sem reutilizar endereço temporário do AI Studio.
- Faça teste com um número não usado em produção. Confira uma saudação, continuidade, pausa humana, deduplicação, follow-up, queda/reinício da VPS e reconexão Evolution.

## Rotina operacional
```bash
sudo systemctl status enviozap1
sudo journalctl -u enviozap1 -f
sudo systemctl restart enviozap1
```

O banco `/opt/enviozap1/data.db` deve ser incluído em backup consistente fora da VPS (use a API de backup do SQLite ou uma ferramenta que faça backup transacional, não copie um arquivo enquanto houver escrita sem estratégia). Guarde também o arquivo de configuração com acesso restrito.

Para atualizar código, programe uma janela controlada: faça backup, verifique as alterações no GitHub, execute `npm test`, `npm run check`, então atualize o checkout e reinicie o serviço. Evite executar o backend duas vezes na mesma instância/banco.

**Atenção:** esta configuração deixa a VPS preparada para executar continuamente, mas **não implanta o programa automaticamente** na VPS. A instalação e a validação da operação real precisam ser feitas no servidor.
