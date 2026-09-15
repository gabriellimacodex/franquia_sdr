# Laboratório Sapore — acesso e descoberta do starter

Verificação iniciada em 10/09/2026. O primeiro snapshot abaixo foi somente leitura; a migração 003 foi aplicada e auditada posteriormente no mesmo dia, conforme o adendo a seguir. O cadastro público foi desabilitado depois da autorização agrupada. As contas, memberships, API e frontend foram publicados posteriormente conforme o adendo; nenhum canal externo foi ativado.

## Adendo após a autorização do gate remoto

- O controle **Allow new users to sign up** foi desabilitado no painel do Supabase e salvo. A verificação independente em `/auth/v1/settings` retornou `disable_signup=true`, e-mail habilitado, usuários anônimos desabilitados e autoconfirmação de e-mail desabilitada.
- A lista final contém dois endereços distintos. `gabriel.lima@cognitaai.com.br` foi convidado e recebeu membership `tester`; `joao.lucas@cognitaai.com.br` foi convidado e recebeu membership `reviewer`. Ambas estão ativas em `cognita-homologacao/sapore`. O Supabase aceitou o envio dos dois convites; Gabriel confirmou o e-mail durante a execução e João ainda aparecia aguardando confirmação na última leitura.
- O modelo `gpt-5.4-2026-03-05` e o teto de R$ 2,00 foram autorizados. Uma única chamada fictícia completou com 1.884 tokens de entrada, 463 de saída, zero reasoning tokens e 19.059 ms. Custo estimado: US$ 0,011655 ≈ R$ 0,06; não houve repetição.
- O inventário atual da VPS `cognita` encontrou somente sete containers `deskcommcrm-*`, portas públicas 80/443 no Caddy desse produto e a porta local 3100 livre. As releases Sapore documentadas anteriormente e o n8n que existiam nessa máquina não estão mais presentes; nenhum container, rede, proxy ou serviço foi alterado.
- `n8n.cognitaai.com.br` foi localizado, mas apresentou erro TLS. `sdr-n8n.cognitaai.com.br` respondeu por HTTPS. Como o envio de recuperação por e-mail não está configurado, foi criado o backup restrito `/opt/cognita-n8n/backups/n8n-before-owner-reset-20260910T213500Z.sql.gz` (SHA-256 `e2d75061254ed4ca4b43cdb53fd3be62145abe93f72327e80671bd0cd596fe80`) e executado o reset oficial do único proprietário. O responsável concluiu o novo cadastro e o acesso foi confirmado. Foram acrescentadas duas credenciais `httpHeaderAuth` exclusivas do laboratório: `5f603fed1aa3de6e` para entrada e `cbb70ce8224e7fb0` para callback. Os valores foram armazenados também em `/opt/sapore-sdr/secrets/n8n.env` com modo `600`; nenhum valor foi exibido ou versionado. Depois que o responsável salvou diretamente a credencial OpenAI, seus metadados foram confirmados como `openAiApi` ID `YRo1qru26pQn9zI1`, nome `OpenAI account`. Antes do import foi salvo `/opt/cognita-n8n/backups/n8n-before-sapore-workflow-20260910T220500Z.sql.gz` (SHA-256 `d4611227bfc1a04d508ba79748caf716e0bc09de1d424893e47674f9df8a7592`). O workflow novo `SaporeAsyncV1Lab` foi importado com cinco nós, endpoint `/v1/responses`, referências às três credenciais e `active=false`. Os três workflows anteriores permaneceram intactos e inativos.
- A conexão `sdr_runtime` já existente no diretório privado local foi copiada para `/opt/sapore-sdr/secrets/database.env` com modo `600`; a CA pública foi instalada separadamente. Um container temporário confirmou TLS estrito e `current_user=sdr_runtime`, sem persistir dados.
- A API isolada foi iniciada na imagem `sapore-sdr:sprint2-20260910`, com runtime restrito, TLS estrito, `EXECUTION_MODE=laboratory`, retenção e outbound desligados. O domínio `sdr-api.cognitaai.com.br` resolve para `93.127.212.149`; `/health` e `/ready` responderam HTTP 200 por HTTPS. O worker foi iniciado somente para a execução autorizada e depois parado com código 0.
- Antes do gasto, dois ciclos TDD corrigiram o validador n8n para aceitar IDs `lab-<md5>:<uuid>` e fixaram `max_output_tokens=1200`; a suíte passou 98/98. O job fictício concluiu na primeira tentativa, persistiu duas mensagens do agente, três fatos com evidência e um evento. Deliveries e canais habilitados permaneceram em zero. Depois, o workflow foi despublicado, o webhook voltou a HTTP 404 e o n8n registrou exatamente uma execução para `SaporeAsyncV1Lab`.
- O Caddy existente recebeu apenas o vhost separado da API depois do backup `/root/deskcommcrm/Caddyfile.before-sapore-sdr-20260910T215400Z`. A configuração foi validada antes do reload; `cos.cognitaai.com.br` respondeu HTTP 307 antes e depois.
- O Site `Borelli Expansão` recebeu `SUPABASE_URL`, `SUPABASE_ANON_KEY` secreta e `SDR_API_URL`, preservou acesso `custom` e passou a permitir somente Gabriel e João. A versão 3 foi publicada com sucesso em `https://borelli-expansao.ana-mendes.chatgpt.site`.

## Adendo autoritativo após a migração 003

- `sdr.lab_sessions` existe e está vazia; o catálogo passou a ter 22 tabelas, 18 com RLS habilitada e forçada.
- `003_lab_sessions` aparece uma única vez no ledger do produto, aplicada em `2026-09-10T19:53:28.483029Z`, e no histórico Supabase como `20260910195328_sapore_sdr_003_lab_sessions`.
- `sdr_runtime` possui somente `SELECT`, `INSERT`, `UPDATE` e `DELETE` na tabela, sem `TRUNCATE`, `REFERENCES`, `TRIGGER`, propriedade ou `CREATE` no schema.
- `anon`, `authenticated` e `service_role` continuam sem `USAGE` no schema `sdr` e sem acesso direto à tabela.
- Naquele momento da migração, o projeto ainda tinha zero usuários Auth e zero memberships; o estado posterior está no primeiro adendo acima.
- Não há canal habilitado, sessão persistida, API/worker Sapore em execução, workflow novo do laboratório, chamada ao modelo ou envio externo.

Esse adendo substitui somente as afirmações temporais conflitantes do snapshot anterior. Os achados sobre ausência de memberships, starter não localizado e riscos de liberação permanecem válidos.

### Revalidação somente leitura — `2026-09-10T21:13:34Z`

- Projeto `ACTIVE_HEALTHY`, PostgreSQL `17.6.1.166`.
- Migração Supabase `20260910195328_sapore_sdr_003_lab_sessions` e ledger do produto continuam com uma ocorrência.
- `lab_sessions` permanece com RLS habilitada e forçada; runtime com exatamente DELETE/INSERT/SELECT/UPDATE e sem `CREATE` no schema.
- `anon`, `authenticated` e `service_role` continuam sem `USAGE` no schema. Uma consulta adicional comprovou zero CRUD desses três papéis em `brands`, `channels`, `memberships` e `webhook_receipts`, as quatro tabelas privadas sem RLS apontadas pelo advisor.
- Na revalidação das `2026-09-10T21:13:34Z`, as contagens ainda eram zero usuários Auth, memberships ativas, sessões do laboratório, canais habilitados e deliveries. Usuários e memberships foram criados depois, conforme o primeiro adendo.
- `/auth/v1/settings` respondeu HTTP 200 com chave publishable habilitada e confirmou `disable_signup=false`, login por e-mail habilitado, usuários anônimos desabilitados e autoconfirmação de e-mail desabilitada.
- Advisors não trouxeram novo alerta específico de RLS para `lab_sessions`. Permanecem os achados documentados de defesa em profundidade e performance; nenhuma remediação foi aplicada sem autorização.

## Snapshot inicial anterior à migração (histórico)

Projeto `xxvfuyydhfijhudtytsk`:

- Conexão PostgreSQL TLS do runtime válida; 21 tabelas, 17 com RLS forçada. Isolamento por tenant/marca, hash da versão e privilégios restritos passaram na verificação existente.
- `sdr.lab_sessions` ainda não existe: migração 003 pendente.
- Nenhuma membership ativa para `cognita-homologacao/sapore`. Isso não significa que não existam contas no Supabase Auth; a consulta contou somente associações da aplicação.
- A API Auth retornou HTTP 200, `disable_signup=false`, `external.email=true` e `external.anonymous_users=false`. **Cadastro público está habilitado**, diferentemente do registro de 09/09. A configuração não foi alterada nesta auditoria; a origem da mudança não foi determinada.
- Canal WhatsApp do piloto continua desabilitado, com três números de teste cadastrados. Não houve envio nem chamada de modelo.

O backend exige identidade validada no Auth e membership ativa. Cadastro Auth por si só não concede acesso ao laboratório. Ainda assim, o cadastro público precisa ser desabilitado administrativamente antes da liberação, conforme o piloto fechado aprovado.

## Starter de autenticação: resultado da busca

- Workspace: somente `borelli-expansao` e `sapore-sdr`; nenhum starter adicional com `@supabase/ssr`, cookies SSR ou callback de confirmação encontrado, incluindo arquivos ocultos e worktrees consultados.
- Sites na conta conectada: a publicação Borelli original permanece na versão 2 (05/09); `borelli-expansao-sdr` não tem versão publicada. Nenhuma publicação do starter relatado foi identificada.
- GitHub conectado: instalação `8888Codex`, 22 repositórios, paginação esgotada. Nenhum candidato compatível com o starter Sapore/Borelli/Next/Supabase. `agent-platform-sdr` é outro projeto, Python/FastAPI/Streamlit, e não contém o starter descrito.
- VPS informada: inventário dos projetos sob `/opt` e serviços em execução não identificou uma aplicação Auth nova/separada. As releases Sapore continuam sendo as preparações de 08/09 e 09/09, sem API/worker persistentes.
- A ferramenta de descoberta de threads informou indisponibilidade neste host. Não foi possível pesquisar o código não publicado de outra tarefa Codex Cloud, contas não conectadas ou outros provedores.

Não concluir que o starter não existe: ele **não foi localizado nos ambientes acessíveis**. Obter o link da tarefa, repositório ou publicação original antes de importá-lo. O laboratório existente já tem login Supabase real em `app/components/pilot-lab`, renovação de token e autorização backend; não criar uma autenticação paralela nem utilizar o login fictício Borelli.

## Correção local da migração

O runner anterior aplicava 003 e o hardening, mas não concedia ao runtime existente acesso à tabela recém-criada. Reexecutar o provisionamento completo do runtime poderia remover grants de publicação até a execução do segundo script.

- Runner extraído para função testável; CLI mantém o contrato existente.
- `scripts/provision-lab-grants.sql` concede somente CRUD de `sdr.lab_sessions`, preservando os grants existentes de runtime/publicação.
- Grants e migração 003 executam na mesma transação; reexecução não repete o DDL nem apaga histórico.
- Instalação sem runtime continua exigindo provisionamento separado. Papéis elevados, com associação a outros papéis ou propriedade de tabelas do produto são rejeitados.
- Testes cobrem upgrade, repetição, bloqueio dos papéis HTTP e rollback da etapa 003 quando o papel é inseguro.
- Verificação local final: `npm run check` aprovado, TypeScript e 83/83 testes. Os cinco testes novos seguiram falha observada e correção incremental. Grants positivos do laboratório foram conferidos individualmente; ACLs anteriores do runtime foram comparadas antes/depois. Nenhum teste desta suíte chamou IA ou acessou o Supabase remoto.

Estado posterior: a correção foi aplicada ao Supabase e auditada conforme o adendo. A imagem candidata local `sapore-sdr:sprint2-fabc5f421d1a` inclui a correção e o preflight que rejeita chaves Supabase privadas; passou 96/96 testes em Linux/arm64 e ainda não foi publicada nem reconstruída na VPS Linux/amd64.

## Alerta `public.rls_auto_enable()`

Metadados e definição consultados sem executar a função:

- Função sem argumentos, retorno `event_trigger`, owner `postgres`, `SECURITY DEFINER`, `search_path=pg_catalog`.
- EXECUTE efetivo para `anon` e `authenticated` confirmado.
- Gatilho vinculado: `ensure_rls`, habilitado em `ddl_command_end` para `CREATE TABLE`, `CREATE TABLE AS` e `SELECT INTO`.
- Corpo habilita RLS em novas tabelas do schema `public`. Não faz parte das migrações Sapore.

Preservar o mecanismo de habilitação de RLS. Não remover a função/gatilho nem trocar automaticamente para SECURITY INVOKER. Avaliar a revogação pontual de EXECUTE para `PUBLIC`, `anon` e `authenticated`, verificando depois que o gatilho continua habilitado e funciona. O achado de ACL não foi apresentado como prova de exploração por RPC: a função tem retorno especial de event trigger e nenhuma chamada exploratória foi executada.

Referências oficiais consultadas: [segurança da Data API](https://supabase.com/docs/guides/api/securing-your-api), [alerta 0028](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) e [conector MCP](https://supabase.com/docs/guides/ai-tools/mcp).

## Bloqueios atuais para liberação

1. João confirma o convite e ambos concluem login/logout reais no frontend publicado.
2. Validar negação sem membership, isolamento tester/reviewer e retomada da sessão pelo frontend sem reativar o worker.
3. Qualquer nova chamada exige nova autorização e novo teto; o gate de R$ 2,00 foi encerrado depois de uma execução.
