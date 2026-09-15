# Aplicação administrativa no Supabase

Executar como o papel que cria os objetos (`postgres` no projeto Supabase). Confirmar antes que `sdr`, `sdr_runtime` e `public.sapore_sdr_migrations` pertencem exclusivamente a este produto ou ainda não existem. Não reutilizar um schema/papel de outra aplicação. A API HTTP do projeto não substitui a conexão administrativa PostgreSQL; o SQL Editor do Dashboard é uma alternativa para esta preparação.

Manter `sdr` fora dos schemas expostos pelo PostgREST. Confirmar onde a extensão `vector` está instalada e se `vector` é resolvido pelo `search_path` das conexões administrativa e runtime. Não mover uma extensão existente.

## Runner

Com a conexão administrativa fornecida por arquivo local ignorado ou gerenciador de segredos:

```sh
node --env-file=.env.migrations --import tsx scripts/migrate.ts
```

O runner prepara e protege o ledger em uma transação. Depois aplica `001_sdr`, `002_versions` e `003_lab_sessions`, cada uma com advisory lock, hardening de `sdr` e registro da versão na mesma transação. Na etapa 003, aplica também `scripts/provision-lab-grants.sql`: concede acesso à tabela de sessões quando o runtime já existe, sem redefinir os grants de publicação. Um runtime ausente continua exigindo o provisionamento inicial; um papel elevado é rejeitado. Em repetições, as versões já registradas são preservadas e os privilégios são novamente restringidos. A ausência de registro não torna uma migração SQL já aplicada manualmente segura para reexecução; verificar a estrutura antes de registrar qualquer versão preexistente.

## SQL Editor do Dashboard

Os comentários abaixo indicam onde colar **o conteúdo integral** do arquivo correspondente. Executar cada bloco completo, incluindo `BEGIN` e `COMMIT`. Não registrar uma migração se seu SQL falhar. Se uma execução deixar a sessão em transação abortada, executar `ROLLBACK` antes de tentar novamente.

1. Preparar o ledger usando [provision-migration-ledger.sql](../scripts/provision-migration-ledger.sql):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('sapore_sdr_migrations'));
-- Cole aqui scripts/provision-migration-ledger.sql.
COMMIT;
```

2. Consultar `SELECT version FROM public.sapore_sdr_migrations ORDER BY version;`. Para cada migração pendente, executar o bloco abaixo. Aplicar primeiro `001_sdr`, depois `002_versions` e `003_lab_sessions`. O bloqueio de versão existente torna uma repetição acidental um erro sem alterações.

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('sapore_sdr_migrations'));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.sapore_sdr_migrations WHERE version='001_sdr') THEN
  RAISE EXCEPTION '001_sdr is already applied';
 END IF;
END $$;
-- Cole aqui migrations/001_sdr.sql.
-- Cole aqui scripts/provision-private-schema.sql.
INSERT INTO public.sapore_sdr_migrations(version) VALUES('001_sdr');
COMMIT;
```

Para a segunda migração, substituir as três ocorrências de `001_sdr` no SQL por `002_versions` e colar `migrations/002_versions.sql` no lugar da primeira migração. Manter o conteúdo de [provision-private-schema.sql](../scripts/provision-private-schema.sql) antes do registro/commit.

Para a terceira, usar `003_lab_sessions` e `migrations/003_lab_sessions.sql`. Depois do hardening, colar também `scripts/provision-lab-grants.sql`, **antes do registro/commit**, para que tabela, permissões e ledger sejam aplicados atomicamente. A criação das sessões não habilita o canal WhatsApp, não cria usuários Auth e não insere memberships.

3. Se as três migrações já estiverem aplicadas, reaplicar somente o ledger, o hardening e os grants do laboratório: executar o primeiro bloco e depois `BEGIN;`, o conteúdo de `scripts/provision-private-schema.sql`, o conteúdo de `scripts/provision-lab-grants.sql`, e `COMMIT;`. Não apagar registros do ledger nem reaplicar o DDL para ajustar permissões.

4. Provisionar o runtime: aplicar `scripts/provision-runtime-role.sql` e depois `scripts/provision-publisher-grants.sql`, preferencialmente em uma transação administrativa. A segunda aplicação é necessária sempre que o primeiro script for reaplicado, pois o primeiro redefine os grants do runtime. Definir sua senha por mecanismo seguro, sem incluí-la no SQL versionado ou em logs. O seed usa a conexão administrativa separada.

## Verificação e limites

```sql
SELECT version FROM public.sapore_sdr_migrations ORDER BY version;
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid='public.sapore_sdr_migrations'::regclass;
SELECT rolname,
 has_schema_privilege(rolname,'sdr','USAGE') AS sdr_usage,
 has_table_privilege(rolname,'public.sapore_sdr_migrations','SELECT') AS ledger_select,
 has_table_privilege(rolname,'public.sapore_sdr_migrations','INSERT') AS ledger_insert,
 has_table_privilege(rolname,'public.sapore_sdr_migrations','UPDATE') AS ledger_update,
 has_table_privilege(rolname,'public.sapore_sdr_migrations','DELETE') AS ledger_delete,
 has_table_privilege(rolname,'public.sapore_sdr_migrations','TRUNCATE') AS ledger_truncate
FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');
```

Esperado: três versões; ledger com RLS habilitada, sem FORCE; todos os acessos acima falsos para os papéis HTTP existentes. O owner administrativo mantém acesso ao ledger. `service_role` pode ignorar RLS, por isso as revogações explícitas são necessárias. Confirmar também RLS habilitada/forçada em `sdr.lab_sessions` e privilégios SELECT/INSERT/UPDATE/DELETE para `sdr_runtime`, sem CREATE de schema, TRUNCATE ou alteração de canais.

Os ajustes de default privileges atingem somente `sdr` e o papel criador que executa o script. Defaults globais não são removidos; novos objetos ainda podem recebê-los, inclusive `EXECUTE` de funções para `PUBLIC`. A ausência de `USAGE` em `sdr` bloqueia o acesso direto. Reaplicar o hardening após novas migrações e conferir privilégios efetivos. Papéis HTTP que sejam owners ou herdem acesso de outros papéis exigem revisão específica; esses scripts não alteram memberships globais. Nenhuma permissão de outras tabelas ou default privilege de `public` é modificada.
