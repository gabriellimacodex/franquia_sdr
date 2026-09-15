# S1.03 — Migração do laboratório

Estado em 10/09/2026: **concluída e verificada**.

Projeto de homologação: `xxvfuyydhfijhudtytsk` (`ACTIVE_HEALTHY`, PostgreSQL 17, plano Free).

## Objetivo e aceite

Criar `sdr.lab_sessions` com RLS habilitada e forçada, conceder somente os privilégios necessários a `sdr_runtime`, preservar os grants existentes e provar que a execução repetida do runner não reaplica o DDL nem falha.

## Preflight remoto somente leitura

- Ledger contém `001_sdr` e `002_versions`; `003_lab_sessions` não está registrada.
- `sdr.lab_sessions` e `sdr.channels.kind` não existem.
- Existe exatamente um `memberships_role_check`, ainda limitado a `reviewer` e `admin`.
- Existe uma marca e nenhum identificador conflita com o canal de laboratório que será criado.
- `sdr_runtime` existe, é `LOGIN NOINHERIT`, não tem `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE` ou `REPLICATION`, não recebeu outros papéis e não possui objetos em `sdr`.
- O runtime tem `USAGE` sem `CREATE` no schema; lê canais e memberships, mas não pode alterá-los.
- `anon`, `authenticated` e `service_role` não têm `USAGE` em `sdr`, acesso ao ledger nem acesso direto a canais ou memberships.
- Canal existente está desabilitado; não existem memberships, candidatos, conversas, mensagens ou jobs.
- O projeto não tem branches. Como está no plano Free, o conector não expõe um backup gerenciado; antes do gate, o responsável confirmou explicitamente que o snapshot da S1.02 estava disponível.

## Pacote aprovado localmente

- `migrations/003_lab_sessions.sql` — SHA-256 `e057fa86f7ed9701332d0ead5c35d6bfb00e3eb31dc87474bf07f0108752e8ef`
- `scripts/provision-private-schema.sql` — SHA-256 `3c06588110c11d9ae685d000c215b129507a9e598cc108eff6ccd18bae724b9d`
- `scripts/provision-lab-grants.sql` — SHA-256 `8aec5d17db6224a3e8485cf908abf4423daa9d28721becaa9ac4096c999ede8b`

A política de `lab_sessions` usa subconsultas escalares para que `current_setting()` seja inicializado uma vez por statement, evitando introduzir o alerta de performance `auth_rls_initplan` já existente em outras tabelas.

## Aplicação remota

A migração `sapore_sdr_003_lab_sessions` foi aplicada em uma única transação, com advisory lock, no projeto `xxvfuyydhfijhudtytsk`. O histórico de migrations do Supabase registrou `20260910195328`; o ledger do produto registrou `003_lab_sessions` em `2026-09-10T19:53:28.483029Z`.

Ela executou:

1. adicionar `channels.kind`, mantendo o canal atual como `whatsapp`;
2. permitir o papel de aplicação `tester` em memberships;
3. criar um canal de laboratório desabilitado para cada marca;
4. criar `sdr.lab_sessions`, constraints, RLS forçada e política por tenant/marca;
5. reaplicar o hardening do schema privado;
6. conceder CRUD de `lab_sessions` somente a `sdr_runtime`;
7. registrar `003_lab_sessions` no ledger.

A migração não cria usuários, não insere memberships, não inicia API/worker, não habilita WhatsApp e não envia mensagens.

## Evidência local

- `npm run check`: TypeScript aprovado; 84/84 testes aprovados.
- Testes específicos de migração e laboratório: 11/11 aprovados.
- Novo teste `laboratory RLS caches tenant and brand settings once per statement`: falhou com a política antiga e passou após o ajuste.
- A suíte cobre upgrade, reexecução do runner, preservação de grants, isolamento entre testadores e rollback transacional quando o runtime é inseguro.

## Evidência remota pós-migração

- Catálogo: `sdr.lab_sessions` existe com dez colunas, chave primária composta, unicidade de requisição e duas chaves estrangeiras; `channels.kind` e o novo `memberships_role_check` correspondem ao pacote aprovado.
- RLS: `relrowsecurity=true` e `relforcerowsecurity=true`; a política `lab_sessions_scope` aplica tenant e marca em `USING` e `WITH CHECK`, com `current_setting()` encapsulado em subconsultas escalares.
- Grants: `sdr_runtime` recebeu exatamente `SELECT`, `INSERT`, `UPDATE` e `DELETE` em `lab_sessions`; não possui atributos elevados, papéis herdados, propriedade de objetos nem `CREATE` no schema.
- API Supabase: `anon`, `authenticated` e `service_role` continuam sem `USAGE` no schema e sem privilégios na nova tabela.
- Isolamento real: conectado diretamente como `sdr_runtime`, o teste confirmou leitura, update e delete no escopo correto; tenant e marca incorretos não viram a sessão; insert fora do escopo retornou SQLSTATE `42501`.
- Higiene: os registros usados no teste foram removidos dentro do fluxo transacional. A conferência final encontrou zero candidatos, conversas ou sessões de auditoria persistidos.
- Operação: há um canal `laboratory`, desabilitado, e o canal `whatsapp` preexistente continua desabilitado. Nenhum worker ou envio foi iniciado.
- Reexecução: o runner foi executado duas vezes no teste de upgrade sem erro ou reaplicação de DDL. No remoto, há exatamente um registro `003_lab_sessions`, portanto a mesma lógica toma o caminho `skip_ddl_reapply_hardening_and_grants`.
- Pós-check completo: TypeScript aprovado e 84/84 testes aprovados depois da aplicação remota.

## Rollback e parada

- Falha durante a migração: a transação inteira é revertida automaticamente.
- Falha de verificação após commit: não iniciar release, API ou worker; preservar o canal desabilitado e restaurar o ponto de retorno da S1.02.
- Não executar rollback destrutivo por inferência. A restauração precisa usar o snapshot aprovado e ser autorizada como uma operação separada.

## Achados fora da S1.03

Os advisors pós-migração não apontaram falha de RLS nem `auth_rls_initplan` em `lab_sessions`. Eles mantêm questões preexistentes: quatro tabelas sem RLS, a função `public.rls_auto_enable()` executável por papéis HTTP, `sdr.immutable_version()` sem `search_path` fixo, `vector` em `public`, 17 políticas antigas sem init plan, 18 chaves estrangeiras antigas sem índices e três índices ainda não utilizados.

A nova chave estrangeira de `lab_sessions` para `versions` acrescentou um alerta informativo de índice ausente, elevando o total de 18 para 19. Isso não bloqueia o aceite funcional da S1.03, mas deve ser avaliado em uma migração de performance separada, sem reescrever a migration já aplicada. Embora os papéis HTTP atualmente não tenham `USAGE` ou privilégios diretos em `sdr`, a estratégia de RLS das quatro tabelas deve ser decidida separadamente para não bloquear o runtime sem políticas adequadas.
