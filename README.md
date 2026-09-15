# Sapore SDR — implementação do piloto

Backend e worker independentes do protótipo e dos workflows existentes. O canal é a Kapso, o n8n executa o modelo, e o PostgreSQL guarda o estado do produto. O laboratório React está no projeto irmão `borelli-expansao`, em `/laboratorio-sdr`.

**Estado: Supabase provisionado e conexão TLS validada localmente e na VPS; API/worker ainda não ativados e sem envios autorizados.** Os artefatos Kapso/n8n são rascunhos, não integrações já ativas. Consulte [o registro do Supabase](docs/supabase-provisioning-20260909.md), [o estado da entrega](docs/implementation-status.md), [a preparação da VPS](docs/vps-preflight.md) e [o procedimento Kapso/n8n](docs/kapso-runbook.md) antes de configurar qualquer serviço remoto.

## O que está implementado

- Contratos Zod, API Fastify, autenticação interna separada e validação HMAC sobre o webhook bruto.
- Fila durável no PostgreSQL, deduplicação, debounce, invalidação de contexto e reserva única de envio. Resultado ambíguo não causa reenvio cego.
- Identidade estável, fatos com evidências, correções preservadas, relações e histórico isolados por organização, marca e candidato.
- Fontes aprovadas/versionadas e recuperação textual ou híbrida com pgvector. Ausência de embeddings é informada como busca textual, não simulada como busca vetorial.
- Prompt Sapore e saída estruturada; recomendação comercial determinística, sem aprovação automática. Referência de investimento: R$ 250–280 mil; composição ainda desconhecida.
- Adaptadores de transcrição, geração de briefing e atribuição humana. Chamadas reais ainda precisam de credenciais e homologação.
- Laboratório com Supabase Auth, autorização por associação à marca, conversas, memória, fontes, versões e avaliação humana. Sem conteúdo real de piloto quando a conexão não está configurada.
- Rascunhos e versões imutáveis, restauração, testes vinculados ao hash e publicação condicionada a relatórios válidos. Publicar não liga o canal.
- Verificação do papel PostgreSQL de execução e rotina de retenção de até 30 dias, desligada por padrão.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `src/domain.ts`, `src/prompts.ts` | Memória, qualificação, controles e prompt |
| `src/store.ts`, `src/engine.ts` | Estado durável, processamento e validação do resultado |
| `src/webhooks.ts`, `src/kapso.ts`, `src/audio.ts` | Adaptadores do canal |
| `src/knowledge.ts`, `src/versioning.ts` | Conhecimento, rascunhos e publicação |
| `src/server.ts`, `src/worker.ts` | Processos separados de API e processamento |
| `migrations/` | Esquema do produto e políticas de isolamento |
| `integrations/` | Geradores locais de artefatos Kapso/n8n |
| `evaluations/` | Cenários determinísticos; não representam avaliação de um modelo real |
| `tests/` | Testes locais, com PostgreSQL PGlite e transportes externos simulados |

## Verificação local sem credenciais

Node.js 22.13 ou superior:

```sh
npm ci
npm run check
npm audit --omit=dev
docker compose config --no-env-resolution --no-interpolate --quiet
```

Esses comandos não enviam WhatsApp, não usam modelos e não alteram o Supabase. Os testes de banco criam apenas bancos locais fictícios. `build` verifica TypeScript; a execução usa `tsx`, inclusive na imagem Docker.

## Configuração e implantação

Segredos devem ser fornecidos por arquivo local ignorado ou gerenciador de segredos. Não inserir chaves nos JSONs dos workflows, no código, no frontend ou em logs. Rotacionar as credenciais compartilhadas em chat antes da ativação.

### 1. Banco e usuários separados

Preparar duas conexões PostgreSQL TLS para o banco **do produto**, não para o banco interno do n8n:

- Migração/provisionamento: conexão administrativa controlada, usada somente nessas operações.
- Execução: papel `sdr_runtime`, sem superuser, BYPASSRLS, criação de papéis/bancos, propriedade de tabelas ou possibilidade de assumir outro papel.

A chave HTTP `sb_secret_…` não substitui a conexão PostgreSQL. Manter o esquema `sdr` fora dos esquemas expostos pelo PostgREST. O frontend acessa dados do produto pela API Fastify, nunca diretamente por uma chave privilegiada.

Com um arquivo `.env.migrations` local contendo a conexão administrativa:

```sh
node --env-file=.env.migrations --import tsx scripts/migrate.ts
```

O runner protege o ledger de migrações em `public` com RLS e revogações dos papéis HTTP e restringe o schema `sdr` após cada migração, inclusive em reexecuções. Na migração 003, concede acesso à tabela do laboratório a um runtime existente sem redefinir seus grants de publicação. Para aplicar pelo SQL Editor do Supabase com os mesmos registros e transações, seguir [a preparação administrativa do banco](docs/supabase-database-setup.md).

Em uma sessão SQL administrativa, aplicar nesta ordem:

1. `scripts/provision-runtime-role.sql`.
2. `scripts/provision-publisher-grants.sql`, após as três migrações.
3. Definir a senha do papel pelo gerenciador de segredos ou `\password sdr_runtime`, sem registrá-la no SQL.

Criar os usuários de homologação no Supabase Auth e associar seus IDs em `adminUserIds` do arquivo `.local/pilot.json`. O arquivo local já contém somente os três números autorizados, sem senhas. O responsável humano confirmado para o piloto Sapore é Gábriel Limá; resolver e verificar seu ID de usuário na Kapso antes de preencher `responsibleUserId`. O seed não cria contas de autenticação nem escolhe um operador automaticamente.

```sh
node --env-file=.env.migrations --import tsx scripts/seed.ts
```

O seed é não destrutivo: não sobrescreve configurações existentes, não muda o responsável de um canal já cadastrado e não habilita envios. Alterações posteriores requerem uma operação administrativa explícita. A versão inicial é selecionada, mas identificada como **não avaliada**.

### 2. API e worker

Configurar `.env` conforme `.env.example`, agora com `DATABASE_URL` do papel de execução. Usar três tokens internos diferentes para Function Kapso, entrada n8n e callback n8n.

- `PUBLIC_API_URL`: origem HTTPS pública do novo backend.
- `LAB_ORIGIN`: origem exata do laboratório, para CORS.
- `SUPABASE_URL` e `SUPABASE_ANON_KEY`: URL do projeto e chave pública anon/publishable, não secret/service-role.
- `OPENAI_API_KEY`: somente servidor; usada em embeddings/transcrição. A execução conversacional usa a credencial OpenAI do n8n.
- `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false`, `RETENTION_ENABLED=false` inicialmente.

Para desenvolvimento, iniciar API e worker em processos separados:

```sh
npm run dev
```

```sh
npm run worker
```

Para o servidor, após revisar os arquivos e as credenciais:

```sh
docker compose up --build -d
```

O Compose publica somente `127.0.0.1:3100`; manter `PORT=3100` e configurar proxy reverso HTTPS sem expor o banco ou credenciais. `/health` verifica o processo e `/ready` a conexão com o banco. A inicialização rejeita papéis PostgreSQL privilegiados; validar também migrações/grants, pois `/ready` sozinho não os verifica. Antes de iniciar qualquer serviço do Sprint 2, executar `npm run preflight:sprint2`: ele exige modo laboratório, TLS, porta/origens aprovadas, retenção e WhatsApp fechados, tokens internos distintos e chave Supabase pública — chaves `sb_secret_…` ou JWT `service_role` são recusadas —, retornando apenas um resumo sem segredos. A imagem anterior já foi construída no Linux da VPS, sem iniciar API ou worker; a candidata atual permanece local. Ver [registro da preparação](docs/vps-preflight.md).

Não iniciar o worker somente para verificar o container: `CHANNEL_ENABLED=false` bloqueia envios, mas não impede processamento de trabalhos/briefings já pendentes e chamadas ao n8n. Smoke tests sem integrações devem usar transportes simulados, rede desabilitada e banco fictício isolado.

### 3. Laboratório

No ambiente do projeto `borelli-expansao`, fornecer somente:

```dotenv
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=chave-publica-anon-ou-publishable
SDR_API_URL=https://backend-de-homologacao
```

O endpoint `/api/pilot-config` expõe apenas essa lista permitida e recusa chaves secret/service-role. Acessar `http://localhost:3000/laboratorio-sdr` durante o desenvolvimento. A autenticação real só funciona após conectar o ambiente e cadastrar uma associação ativa em `sdr.memberships`.

### 4. Kapso, n8n e liberação

Seguir [o runbook](docs/kapso-runbook.md). Criar recursos **novos**, inicialmente sem gatilhos ativos, usando IDs e credenciais verificados. Não substituir workflows de Revenue ou o chat de homologação existente.

Antes de qualquer liberação, ainda é obrigatório implementar/conectar a prova do WAMID do envio nativo, verificar os eventos reais de Handoff/Resume, testar pausas nos limites do envio e executar a suíte com modelo real e avaliação humana. Não basta mudar as variáveis de habilitação.

A autorização de envio exige também o registro específico em `sdr.channels` habilitado, operador preenchido e testador ainda permitido. Esse registro começa desabilitado; sua alteração administrativa é uma etapa explícita da liberação, separada dos gates da Function/backend e do gatilho Kapso. Não habilitar outros números ou marcas junto com este piloto.

## Conhecimento e versões

O seed inclui apenas a referência comercial autorizada de investimento. A especificação SDR e o prompt de outra marca não entram como material comercial recuperável. Demais informações comerciais exigem revisão de fonte.

Indexação explícita de uma versão:

```sh
node --env-file=.env --import tsx scripts/index-knowledge.ts TENANT BRAND VERSION
```

`--embed` faz chamadas externas com cobrança quando `OPENAI_API_KEY` está presente. Sem a opção/chave, a indexação é textual. Os trechos e vetores são vinculados à versão e filtrados por organização/marca/validade.

Endpoints administrativos: `GET/POST /v1/versions/draft`, `POST /v1/versions/:id/restore`, `GET /v1/versions/validation/:hash`, `POST /v1/versions/publish`. A publicação exige `approvedHash` igual ao rascunho atual e validações do mesmo conteúdo. O laboratório atual inspeciona essas versões; não substitui ainda o editor local do protótipo.

Relatórios são registrados por um operador confiável, não enviados livremente pelo navegador:

```sh
node --env-file=.env.migrations --import tsx scripts/record-validation.ts TENANT BRAND HASH AUTH_USER_ID REPORT_FILE
```

A política exige suítes determinística e conversacional medidas, pelo menos 30 cenários, duas execuções, zero violações críticas e média humana mínima 4/5 na avaliação conversacional. O registro declara evidências; ele não comprova sozinho que um relatório é verdadeiro. Não converter fixtures sintéticas em relatórios medidos. Alterar conteúdo invalida a aprovação anterior; restaurar não modifica o histórico.

## Operação e limites

- O worker conserva tokens, latência por trabalho, versão, fontes e erros. Custos reais, percentil 95 e qualidade conversacional ainda não foram medidos. As tarifas precisam de configuração/verificação antes de informar valores monetários.
- `RETENTION_ENABLED=true` habilita remoção periódica de dados expirados do banco do produto. Validar primeiro `purgeRetention(..., {dryRun:true})`. Retenção em Kapso, backups e outros provedores depende da configuração desses serviços e não é apagada por essa rotina.
- Nenhum envio ativo, campanha, agenda, CRM ou follow-up automático nesta etapa.
- Rollback: fechar os gates, pausar o novo fluxo e manter atendimento humano. Preservar registros de entrega ambígua; não limpar a fila para tentar reenviar.
- O funcionamento local não comprova segurança de produção, conformidade jurídica, qualidade 100% ou disponibilidade do provedor. A habilitação depende da homologação descrita acima.
