# Preparação isolada da VPS — 08/09/2026

O acesso SSH `root` a `187.127.49.144` foi validado. A senha foi usada somente no prompt de autenticação, sem gravação no projeto, imagem, arquivo de ambiente ou comandos remotos. A credencial compartilhada no chat deve ser rotacionada; a troca não foi executada automaticamente para evitar bloquear outros acessos.

## Inventário observado

- Linux x86_64, 2 CPUs e aproximadamente 8 GB de RAM.
- Cerca de 83 GB de disco disponíveis antes da preparação.
- Docker 29.7.2 e Docker Compose 5.1.0 já instalados.
- 11 containers de produtos existentes, incluindo Revenue Bridge, agentes comerciais, n8n e bancos próprios. Nenhum foi alterado ou reiniciado.
- Portas 80/443 ocupadas pelo ingress Caddy existente; a porta 3100 estava livre. Não houve modificação de proxy, DNS, firewall ou publicação de novas portas.

## Artefato preparado

| Item | Valor |
| --- | --- |
| Diretório remoto | `/opt/sapore-sdr/releases/20260908T213051Z` |
| Pacote recebido | `source.tar.gz` |
| SHA-256 do pacote | `a3a3d93278ea97b48a284e2dcef0544f8c2538169b82eb4186df0fb3123f5885` |
| Imagem | `sapore-sdr:homologacao-20260908t213051z` |
| ID da imagem | `sha256:879a0387cabb41dcd413c11445ee698d115fe16c836ff85d8c23932fde7f78e5` |
| Plataforma / usuário | `linux/amd64` / `node` |
| Node observado no container | `v22.23.2` |

O pacote foi montado por lista explícita de arquivos, sem `.env`, `.local`, senhas ou cadastro dos testadores. O hash foi conferido antes da extração. A imagem passou no `npm ci` e no build TypeScript; a instalação não reportou vulnerabilidades conhecidas. As mensagens de atributos macOS ignorados pelo `tar` não interromperam a extração/build.

O diretório representa o código desse build, não uma implantação ativa. Não foi criado apontamento `current`, processo persistente, gatilho ou credencial de produção. Os documentos dentro do pacote são o retrato anterior à preparação; este registro local descreve os resultados posteriores.

## Snapshot anterior da candidata local

A candidata local `sapore-sdr:sprint2-fabc5f421d1a`, hash de pacote `fabc5f421d1a3941b5d9a04fb1723089449c1605d70094f2bcf09c7706bbdd76` e ID local `sha256:cdeb139c9015ecb640c1bf3b13b18d1f206eaeb1e6f8191836d8283f04b277f5`, passou 96/96 testes em Linux/arm64, sem rede ou credenciais. O preflight também foi executado dentro da própria imagem, com filesystem somente leitura e rede desabilitada, retornando somente o resumo seguro esperado e rejeitando chaves Supabase secretas ou de `service_role`. O estado posterior da reconstrução Linux/amd64 está registrado a seguir.

## Reconstrução após o gate remoto — 10/09/2026

A VPS atual foi encontrada reprovisionada: somente sete containers `deskcommcrm-*` estavam presentes, `/opt` não continha as releases Sapore anteriores e não havia container, imagem ou volume n8n. Nenhum desses serviços foi alterado ou reiniciado.

| Item | Valor |
| --- | --- |
| Diretório remoto | `/opt/sapore-sdr/releases/20260910T212500Z` |
| SHA-256 do pacote recebido | `edf917e92e3f68321a0168e32862ec141fcc89ab2b2c1dd90ae0720b75f1b0f0` |
| Imagem | `sapore-sdr:sprint2-20260910` |
| ID da imagem | `sha256:8d48730db5a57431707b91b692e0bacc103e12346a0c3d5b421e59a54be592c8` |
| Plataforma / usuário | `linux/amd64` / `node` |

O pacote foi conferido antes da extração e não contém `.env`, `.local` ou `node_modules`. O build encontrou zero vulnerabilidades conhecidas nas dependências de produção e concluiu o TypeScript. A imagem passou 96/96 testes com rede desabilitada, filesystem somente leitura, `/tmp` temporário, 2 CPUs, 1 GiB e 128 processos. O preflight com valores fictícios seguros retornou `ok=true`, modo `laboratory`, TLS ligado, retenção e outbound desligados e porta 3100.

A afirmação acima descreve o estado imediatamente após o build. A ativação posterior autorizada está registrada a seguir.

## Ativação isolada da API — 10/09/2026

- A conexão `sdr_runtime`, a CA e os dois tokens internos do n8n foram instalados sob `/opt/sapore-sdr/secrets/`, fora da release e com arquivos sensíveis em modo `600`.
- Um container temporário validou a conexão PostgreSQL com TLS estrito e `current_user=sdr_runtime`, sem escrita de dados.
- O preflight da imagem final retornou `ok=true`, modo `laboratory`, TLS ligado, retenção e outbound desligados, porta 3100 e as três origens HTTPS esperadas.
- Somente `sapore-sdr-api-1` foi iniciado. O worker não foi criado e não existe canal WhatsApp/Kapso habilitado.
- `sdr-api.cognitaai.com.br` resolve para `93.127.212.149`. O Caddy recebeu um vhost separado que encaminha apenas esse hostname para a API pela rede `sapore-sdr_default`.
- Antes da mudança, foi salvo `/root/deskcommcrm/Caddyfile.before-sapore-sdr-20260910T215400Z`. O Caddyfile passou em `caddy validate` antes do reload; nenhum container do DeskcommCRM foi reiniciado.
- `https://sdr-api.cognitaai.com.br/health` e `/ready` responderam HTTP 200 externa e internamente. `https://cos.cognitaai.com.br` respondeu HTTP 307 antes e depois.

Depois da autorização e antes de qualquer `docker compose up`, executar `npm run preflight:sprint2` com o arquivo de ambiente restrito. O comando precisa retornar `ok: true`, `executionMode: laboratory`, `databaseTls: true`, `retentionEnabled: false`, `outboundEnabled: false` e porta 3100. A saída mostra somente origens HTTPS; não mostra conexão do banco, chaves, tokens ou caminho do webhook. Implantar primeiro somente o serviço `api`; o worker pertence a um gate posterior.

## Teste isolado

A suíte foi executada em container temporário com rede desabilitada, filesystem somente leitura, sem credenciais, portas ou acesso aos bancos existentes. Testes/fixtures foram montados somente para leitura; dados fictícios ficaram em `/tmp` temporário. Limites: 1 CPU, 1 GB de memória e 128 processos, com execução sequencial dos arquivos de teste.

**Resultado: 66 testes passaram, zero falhas, duração aproximada de 125 segundos.** O container foi encerrado e removido automaticamente após a execução, sem deixar um serviço Sapore ativo. Essa duração é da suíte técnica, não da resposta de um modelo. O banco dos testes foi PGlite com dados fictícios; não houve validação do Supabase remoto.

`CHANNEL_ENABLED=false` não desliga a geração pelo worker. Por isso o processo normal do worker não foi usado nesse teste: nenhuma chamada real ao n8n/OpenAI/Kapso foi realizada.

## Pendências para iniciar o serviço

1. Conexão PostgreSQL do Supabase, migrações, papel restrito e grants verificados; não reutilizar bancos de outros produtos da VPS.
2. Chave pública anon/publishable e usuários/memberships do Supabase Auth.
3. Origem HTTPS do backend e configuração de proxy revisada, sem substituir rotas existentes.
4. Credenciais/referências de integração e ID confirmado de Gábriel Limá na Kapso.
5. Homologação da prova WAMID e do controle nativo Handoff/Resume antes de abrir os gates de envio.

Nenhum volume ou container existente precisa ser removido para continuar. Não executar `docker compose down` de outros projetos, `docker system prune`, alterações gerais de firewall ou troca do banco previsto para contornar essas pendências.
