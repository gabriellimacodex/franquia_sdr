# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório. Leia antes de alterar código.

## O que é

`sapore-sdr`: backend + worker do agente SDR da franquia Sapore (piloto Cognita).
Fluxo atual: **WhatsApp → Kapso (cano) → API Fastify (VPS) → fila no PostgreSQL → worker → n8n (executa o modelo) → callback `/internal/n8n/jobs/:id/complete` → guard → entrega via Kapso Messages API**.
Migração em curso: tirar a orquestração do canvas Kapso e deixar o agente visível no n8n — ver `docs/PLANO-KAPSO-CANO-N8N-AGENTE.md` e `docs/FASE2-STATUS.md`.

Estado: **piloto não liberado**. Envio real depende de gates explícitos (ver "Regras duras").

## Comandos

```sh
npm ci
npm run check        # tsc --noEmit + suíte completa (node:test + tsx)
npm run build        # só TypeScript (noEmit)
npm test             # node --import tsx --test tests/*.test.ts
npm run dev          # API Fastify (src/main.ts)
npm run worker       # worker separado (src/worker.ts)
npm run migrate      # exige .env.migrations com conexão administrativa
npm run seed         # seed não destrutivo
npm run preflight:sprint2
```

Um teste isolado: `node --import tsx --test tests/engine.test.ts`.
Não há linter configurado — `npm run check` é o portão.

## Mapa do código

| Caminho | Responsabilidade |
| --- | --- |
| `src/config.ts` | Schema Zod do ambiente; recusa HTTP não-local, tokens internos iguais e flags de WhatsApp em modo laboratório |
| `src/domain.ts`, `src/prompts.ts` | Memória do lead, fatos com evidência, qualificação, guards de saída, prompt |
| `src/engine.ts` | `prepare` (monta contexto + retrieval) e `dispatch` (laboratório vs legado) |
| `src/store.ts`, `src/database.ts` | Fila durável, reserva de envio; `scoped()` abre transação por tenant/marca |
| `src/server.ts`, `src/webhooks.ts`, `src/kapso.ts`, `src/audio.ts` | HTTP, webhook HMAC, envio/WAMID, transcrição |
| `src/knowledge.ts`, `src/versioning.ts` | Retrieval textual/pgvector por versão; rascunhos, publicação e validação por hash |
| `src/lab*.ts`, `src/conversation-review.ts` | Laboratório, sessões, orçamento e revisão humana |
| `migrations/` | `001_sdr.sql`, `002_versions.sql`, `003_lab_sessions.sql` |
| `scripts/` | Migração, seed, provisionamento de papéis SQL, preflight, operações Kapso |
| `integrations/` | Geradores locais dos artefatos Kapso/n8n |
| `evaluations/` | Cenários determinísticos (não são avaliação de modelo real) |
| `tests/` | ~87 arquivos; PGlite como PostgreSQL local e transportes externos simulados |

## Convenções

- ESM + `"type": "module"`. Imports relativos **sempre** com extensão `.js` (`./domain.js`), mesmo em `.ts`.
- TypeScript `strict`, `noEmit`; a execução é via `tsx`, inclusive no container.
- Estilo do `src/` é deliberadamente denso (poucas quebras, sem comentários decorativos). Comentários existem só onde explicam uma decisão de concorrência ou de segurança — mantenha esse padrão em vez de "melhorar" a formatação.
- Contratos de entrada/saída são Zod (`.strict()` quase sempre). Erros de domínio usam `ServiceError(code, status)`; nunca vazar mensagem de upstream.
- Todo acesso a dados do produto passa por `scoped(db, channel, tx => ...)`: advisory lock por `tenant:brand` + `set_config` para RLS. **Não** fazer chamada de rede dentro desse lock.
- Comparações de token/assinatura usam `timingSafeEqual` (`src/security.ts`).
- Testes usam `node:test` + PGlite (`tests/db-helper.ts`). Nenhum teste pode chamar rede, modelo pago ou Supabase real.

## Regras duras

1. **Nunca** habilitar envio: `CHANNEL_ENABLED`, `NATIVE_CONTROL_VERIFIED` e `RETENTION_ENABLED` ficam `false` até homologação descrita no README.
2. **Nunca** commitar segredo, `.env`, chave `sb_secret_…`/`service_role`, token Kapso/n8n ou credencial em JSON de workflow.
3. Migrações só rodam com a conexão administrativa (`.env.migrations`); o runtime usa o papel `sdr_runtime`, sem superuser/BYPASSRLS.
4. Publicação de versão exige `approvedHash` igual ao rascunho e relatório de validação registrado por operador — não converter fixture sintética em relatório medido.
5. Não alterar workflows de Revenue nem o chat de homologação existente; criar recursos novos, sem gatilho ativo.
6. Antes de mexer no caminho de entrega, ler `docs/FASE2-STATUS.md` (anti double-send: a function `sapore-session` retorna `wait`, quem envia é a API).

## Documentação viva

- `docs/implementation-status.md` — estado da entrega, checkpoint mais recente
- `docs/PLANO-KAPSO-CANO-N8N-AGENTE.md` — plano da migração Kapso→n8n
- `docs/kapso-runbook.md`, `docs/vps-preflight.md`, `docs/supabase-database-setup.md` — procedimentos de ambiente
- `docs/sprints/` — histórico por sprint e evidências datadas
