# Plano: Kapso = cano, n8n = agente

Objetivo: o atendimento (prompt, modelo, próximo passo) mora **visível no n8n**. A Kapso só conecta a API oficial do WhatsApp (receber e enviar). A API na VPS persiste, faz allowlist e **valida antes de enviar** — não orquestra o canvas.

Regra desta migração: **um corte por vez**, com ping real no WhatsApp da Nat. Sem dual webhook. Sem “manda de novo” no escuro. Rollback em 5 minutos.

---

## 1. Mapa do que temos AGORA (causa dos erros)

```
WhatsApp (Nat 1093705843816293)
        │ inbound
        ▼
Kapso WORKFLOW (Decide + Wait + Send Text + Handoff)
        │ function sapore-session
        ▼
sdr-api /internal/turns  →  job no Postgres
        │
        ▼
worker (VPS) POST n8n webhook
        │
        ▼
n8n  [webhook → HTTP OpenAI → callback]
        │  (prompt NÃO está no canvas; vai no JSON `instructions`)
        ▼
sdr-api /internal/n8n/jobs/:id/complete  →  guard
        ▼
Kapso Decide de novo → Send Text  →  WhatsApp
```

### Onde cada coisa mora hoje

| Peça | Onde está | Visível no n8n? |
|---|---|---|
| Prompt Sofia v1.1 | `sdr.versions.snapshot.prompt` (publicado `sapore-v1.1-153b9ac1c962`) + fonte `src/prompts.ts` | **Não** |
| Modelo `gpt-5.4-2026-03-05` | snapshot + HTTP n8n | Só no body HTTP |
| Guard (números, 1 pergunta, capital) | `src/domain.ts` no complete | Não |
| Allowlist testers | `sdr.testers` | Não |
| Fatos / lead | Postgres `sdr.facts` / `candidates` | Não |
| Envio WhatsApp | Node Kapso `send_text` | Não |
| Espera da próxima msg | Kapso `wait_for_response` | Não |
| Handoff humano | Kapso node `handoff` + inbox | Não |
| OpenAI | n8n HTTP `api.openai.com/v1/responses` | Node “Structured model response” |

### Por que os erros não evoluem

O “agente” está fatiado em **4 donos**. Cada silêncio foi um dono diferente:

1. Kapso: wait 10s (poll) → handoff; execução `handoff` engole inbound
2. n8n: JS Task Runner 429 / idle 15s / Code node travado → job `PROCESSING_TIMEOUT`
3. API: `POLICY_GUARD` no eco de `500k`; lead preso em `handoff`
4. Prompt: versão no banco, invisível no canvas que você abre

Você abre o n8n procurando a Sofia. Lá só tem cano HTTP. Por isso parece que “não tem agente”.

### O que NÃO se mexe nesta migração

- Número Nat, projeto Kapso, allowlist
- Guard de números comerciais (foi o que salvou de inventar taxa/royalty)
- Painel Conversas (leitura) — continua lendo a API
- Laboratório (`EXECUTION_MODE` lab) — ramo separado; não misturar no corte WhatsApp
- Dual webhook (Kapso workflow **e** webhook de telefone ao mesmo tempo) — **proibido**

---

## 2. Mapa alvo

```
WhatsApp
   │ inbound (Meta)
   ▼
Kapso  [só conexão]
   │ webhook whatsapp.message.received  (UM consumidor)
   ▼
sdr-api  POST /webhooks/kapso
   │ allowlist + persistir mensagem + criar job
   ▼
worker  →  n8n webhook
   ▼
n8n  AGENTE VISÍVEL (Fase 3 = node Agent)
   │ 1. Prompt Sofia no system do Agent
   │ 2. Agent + Structured Output (JSON do contrato)
   │ 3. Callback API
   │    (Fase 1 transitória: HTTP /v1/responses — não é o alvo)
   ▼
sdr-api  complete + GUARD
   │ se ok: authorize-send
   ▼
sdr-api  envia via Kapso Messages API  (não via node send_text do workflow)
   ▼
WhatsApp
```

Kapso **sem** workflow Decide/Wait/Send para este número. Inbox humano continua existindo: se um operador assumir no Kapso, o webhook `conversation.unassigned` / mensagem outbound de humano pausa a API (`handoff`).

### Donos no alvo

| Camada | Responsável | Pode falhar visível? |
|---|---|---|
| Transporte WhatsApp | Kapso | Log Kapso + webhook delivery |
| Porta / allowlist / fatos / guard | sdr-api | Log API + job.error_code |
| Agente (prompt, modelo, turno) | **n8n** | Execução n8n vermelha no canvas |
| Envio | sdr-api → Kapso Messages API | WAMID no `sdr.deliveries` |

Critério de “não aceito mais erros”: **cada falha tem um único lugar para abrir**. Timeout do modelo = execução n8n. Guard = job `POLICY_GUARD`. WhatsApp não entregou = delivery + Kapso logs. Nunca mais 4 SSHs para um “oi”.

---

## 3. Decisões travadas neste plano

1. **Prompt da Sofia no n8n** (visível no canvas). A versão do banco deixa de ser a fonte do WhatsApp. O arquivo `src/prompts.ts` vira cópia de referência; editar conversa = editar n8n.
2. **Guard fica na API.** n8n pode mandar o que quiser; se o JSON violar número comercial / schema, **não envia**. Isso é a rede de proteção. Sem isso, um prompt solto inventa royalty de novo.
3. **Envio pela API Kapso Messages**, não por `send_text` de workflow. Assim o n8n não precisa “devolver o texto para a Kapso decidir enviar”.
4. **Inbound continua na API** (`/webhooks/kapso`), não n8n direto. Allowlist e persistência não podem depender de Code node.
5. **Um consumidor só.** No cutover: desativar trigger do workflow Kapso **antes** de apontar o webhook de telefone para a API (ou o inverso, mas nunca os dois ativos). Sequência está na Fase 3.
6. **Laboratório intacto** até o WhatsApp homologado estável 48h.
7. **Modo Agent no n8n é obrigatório na Fase 3.** A Fase 1 usa HTTP ` /v1/responses` + schema só como ponte segura. Na Fase 3 o canvas troca para o **node Agent** (LangChain/OpenAI Agent), com a Sofia no system message. A saída **continua** sendo o JSON do `AgentDecisionSchema` (Structured Output / parser final) — o Agent não manda texto solto para o WhatsApp. Tools (se houver) só depois do Agent estável com 3 pings verdes.

---

## 4. Fases (ordem obrigatória)

### Fase 0 — Congelar e evidenciar (sem mudar comportamento) — FEITA 2026-09-15

- [x] Inventário + IDs em `backups/fase0-20260915/FASE0-INVENTARIO-ROLLBACK.md`
- [x] Backup Kapso (definition, functions, triggers, webhooks) + n8n (entity + history)
- [x] Trigger inbound `140d43f1…` active; webhook API `bece8a4d…` active; Rede Ideia inactive
- [x] Rollback paper escrito (reativar trigger + CHANNEL_ENABLED)

Achado: hoje trigger Kapso **e** webhook API estão ativos (desenho native-control). Fase 3 remove o trigger.

Nenhum ping. Sem código de produto.

### Fase 1 — n8n deixa de ser cano invisível — FEITA 2026-09-15

- [x] Workflow `SaporeAgentWhatsAppV2` criado — https://sdr-n8n.cognitaai.com.br/workflow/SaporeAgentWhatsAppV2
- [x] Node **Sofia — system prompt** com franchise-sdr-v1.1 no canvas
- [x] Webhook `sapore-sdr-v2-jobs` registrado (403 sem auth / 200 com token)
- [x] Sem Code no caminho; IF sintético; timeouts 120s/180s
- [x] Teste sintético após crédito: execução `105` **success**
- [x] Worker `N8N_WEBHOOK_URL` → `/webhook/sapore-sdr-v2-jobs`
- [x] Kapso intacta; rollback = voltar path v1 no `runtime.env`

Fase 1 **fechada**. Detalhe: `backups/fase0-20260915/FASE1-STATUS.md`

### Fase 2 — API envia WhatsApp direto (ainda com workflow Kapso parado só no send) — FEITA 2026-09-15 (ver `FASE2-STATUS.md`; ping de prova pendente)

Objetivo: o send_text da Kapso deixa de ser necessário.

- Novo endpoint interno, ex. `POST /internal/n8n/jobs/:id/deliver` **ou** no `complete` já autorizado: API chama `POST /meta/whatsapp/v24.0/{phone}/messages` via Kapso (o mesmo caminho que o inbox de teste usou com sucesso).
- Grava `sdr.deliveries.message_id` (WAMID) na hora do send, não espera webhook `message.sent` para “acreditar” (webhook ainda confirma delivered/read).
- `authorize-send` continua: `CHANNEL_ENABLED`, tester, `responsibleUserId`, job `ready`, conversa `automatic`.
- Critério de saída (ping real, **uma** mensagem):
  1. Inbound chega
  2. Execução n8n verde
  3. Outbound no WhatsApp com o texto dos `bubbles`
  4. WAMID em `deliveries`
  - Se o workflow Kapso **também** tentar send: abortar. Por isso o cutover da fase 3 desliga o workflow **antes** de ligar deliver em produção, ou o complete **não** devolve `sapore_reply_text` para a Kapso.

Implementação segura: na fase 2 o complete **envia pela API** e a função Kapso `sapore-session` passa a retornar `wait` (não `send`) quando o job já está `sent`/`dispatched`. Assim não há double-send.

Ping de prova: “oi” → uma resposta. Só então fase 3.

### Fase 3 — Kapso vira cano + n8n vira Agent de verdade

Objetivo: (A) Kapso só transporte; (B) o canvas n8n usa **modo Agent**, não HTTP Responses cru.

#### 3A — Trocar HTTP Responses → node Agent (ainda com Kapso workflow ligado, se Fase 2 já envia pela API) — FEITA 2026-09-16 (ver `FASE3A-STATUS.md`; inclui ramo de briefing)

No workflow `SaporeAgentWhatsAppV2` (ou v3):

1. Substituir o node **OpenAI Responses** (HTTP `/v1/responses`) pelo **Agent** do n8n (OpenAI/LangChain Agent).
2. System message = Sofia (mesmo texto do node atual, editável).
3. User message = `JSON.stringify(job.context)` (mensagens + lead + sources).
4. **Structured Output obrigatório**: schema = `AgentDecisionSchema` / `AGENT_OUTPUT_JSON_SCHEMA` (bubbles, proposals, relations, referral, sourceRefs, nextAction, handoffReason). Sem isso o guard quebra.
5. Sem tools na primeira versão do Agent (zero tool loops). Tools só em fase posterior.
6. Manter IF sintético + callback API.
7. Prova: execução n8n **success** com Agent; sintético verde; um ping WhatsApp “oi” responde.

Rollback 3A: recolocar o HTTP Responses (export JSON do Fase 1 fica em `backups/`).

#### 3B — Aposentar Decide/Wait/Send da Kapso — TENTADA E REVERTIDA 2026-09-16 (ver `FASE3A-STATUS.md`: o webhook `/webhooks/kapso` não recebeu a entrega; provar Kapso → API com o trigger ligado antes de repetir)

Só depois de 3A estável.

Sequência **exata** (ordem invertida = dual consumer):

1. `CHANNEL_ENABLED=false` (API não envia) — freeze outbound
2. Desativar **trigger inbound** do workflow Kapso `a2c54a90-…`
3. Confirmar zero execução `running/waiting` nesse workflow (PATCH `ended` nas presas)
4. Garantir webhook de **phone number** `whatsapp.message.received` → `https://sdr-api.cognitaai.com.br/webhooks/kapso` **ativo e único**
5. Worker + n8n Agent no ar
6. `CHANNEL_ENABLED=true`
7. Ping “oi”

Inbound deixa de passar por Decide. Caminho: Meta → Kapso webhook → API → worker → **n8n Agent** → complete → Kapso Messages API → Meta.

Handoff humano: se `nextAction=handoff`, API chama Kapso **assignment / conversation handoff** (não o node do workflow). Se o operador escrever no inbox, webhook outbound humano → `controlTx handoff` (já existe).

Wait da próxima mensagem: **não precisa** de `wait_for_response`. Cada inbound é um webhook novo → job novo. Isso elimina o bug dos 10s de poll.

Critério de saída da Fase 3:

- Canvas n8n mostra **Agent** (não HTTP `/v1/responses` como cérebro)
- Kapso workflow **sem trigger ativo**
- Um “oi” responde
- Um segundo turno (“São Paulo”) responde **sem** handoff
- `estou com 500k` responde sem `POLICY_GUARD` de eco
- Nenhuma execução nova no workflow Kapso antigo

Rollback fase 3: reativar trigger Kapso; se Agent falhar, voltar HTTP Responses do backup Fase 1; `CHANNEL_ENABLED` como estava.

### Fase 4 — Endurecer o n8n para não repetir o silêncio

Só depois de 3 pings bons (oi + cidade + capital informal `estou com 500k`).

- Proibir Code node com Task Runner neste workflow (lint no export JSON)
- OpenAI 429: retry limitado (2x, backoff) **no HTTP node**, senão falha visível (execução vermelha), nunca hang `running` eterno
- Job WhatsApp deadline 180s alinhado ao timeout n8n
- Se n8n não callback em 90s: worker marca `PROCESSING_TIMEOUT` **e** a conversa **não** fica `human` permanente (já temos resume em execução nova; reforçar)
- Log único por turno: `turn_id`, `n8n_execution_id`, `wamid` — gravar no `sdr.jobs.context`

### Fase 5 — Painel e versão

- Conversas continua lendo API (já iniciado)
- Aviso no laboratório: prompt WhatsApp = n8n, não `POST /v1/versions/publish`
- Opcional: botão “sincronizar prompt do n8n para o banco” — **fora** deste plano

---

## 5. Contrato do agente no n8n (o que você passa a ver)

Node de sistema (editável), conteúdo inicial = Sofia v1.1 já publicada.

Saída JSON obrigatória (igual hoje, senão o guard recusa):

```json
{
  "bubbles": ["texto 1", "texto 2?"],
  "proposals": [],
  "relations": [],
  "referral": null,
  "sourceRefs": [],
  "nextAction": "continue | handoff | stop | nurture",
  "handoffReason": null
}
```

O n8n **não** envia `---QUAL---` no WhatsApp. Score, se existir, fica em campo interno do JSON, nunca em `bubbles`.

Fontes comerciais (R$ 250–280 mil) continuam no `context.sources` que a API injeta no job. O prompt no n8n manda: número da marca só com cláusula em `sources`.

---

## 6. Riscos e como não reintroduzir erro

| Risco | Como evita |
|---|---|
| Dual webhook (Kapso workflow + API) | Fase 3 passo 2 antes do 4; checklist com `GET triggers` e `GET webhooks` |
| Double-send | Fase 2: session só `wait` se job já `sent`; fase 3: workflow morto |
| n8n hang invisível | Sem Code/runner; execução deve ir `success` ou `error` em < 180s |
| Prompt inventa número | Guard na API **antes** do send |
| `500k` derruba turno | Guard de capital informal já no `domain.ts` (r6) — não reverter |
| Lead preso em humano | Inbound novo + conversa automatic; não `controlTx handoff` em timeout de n8n |
| Execução Kapso `handoff` engole msg | Não haverá execução de workflow; inbound é webhook |
| OpenAI 429 | Uma execução por vez no cutover; matar `running` zumbis **antes** do ping |
| Laboratório quebra | `EXECUTION_MODE=whatsapp` no worker de prod; lab não entra neste corte |

---

## 7. Verificação (prova, não narrativa)

Em **cada** fase, só avançar com evidência:

- Kapso messages: 1 inbound + 1 outbound `delivered` (fase 2+)
- n8n: execution `success`, não `running` após 3 min
- SQL: `sdr.jobs.state` em `sent`/`completed`, `error_code` null
- `sdr.deliveries.message_id` preenchido
- Segundo turno no mesmo contato responde

Fase 3 só é “pronta” com **três** pings: `oi` → cidade → `estou com 500k` (eco permitido, sem handoff de guard).

---

## 8. Rollback

1. `CHANNEL_ENABLED=false`
2. Reativar trigger inbound do workflow Kapso `a2c54a90-…`
3. Worker `N8N_WEBHOOK_URL` no v1 se o v2 estiver quebrado
4. `CHANNEL_ENABLED=true`
5. Ping

Tempo alvo: < 5 min. Não apagar o workflow Kapso; só desativar trigger.

---

## 9. Fora de escopo (não misturar)

- Item 2 da auditoria (debounce 4–6s) — depois do cano estável
- Anatomia de mensagem (dois balões = dois sends)
- Agrupar threads Kapso no painel
- Publicar prompt pelo laboratório de 30 cenários

---

## 10. Ordem de execução quando sair do plano

0. Backup JSON Kapso + n8n  
1. n8n v2 com Sofia no canvas (HTTP Responses) + teste sintético — **feita**  
2. Send pela API Kapso sem double-send  
3. **3A** Agent no n8n (Structured Output) → **3B** desligar trigger Kapso + ping real  
4. Endurecer timeout/429  
5. Só então evoluir conversa / tools no Agent

Dono da conversa depois disto: **n8n Agent**. Dono do WhatsApp: **Kapso**. Dono da verdade e do “pode enviar?”: **API**.
