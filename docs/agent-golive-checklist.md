# Checklist — go-live do agente (piloto interno)

Atualizado: 2026-09-15. Canal de teste fixo: `1052683654599692` (Cognita-franquias).  
Segredos: nunca colar no chat. Confirmar só **sim/não** e **quantidade de caracteres**.

## Estado atual (inventário local)

| Item | Status | Evidência |
| --- | --- | --- |
| `phoneNumberId` = `1093705843816293` (Cognita - Nat / `+55 11 93621-2410`) | Verde | Migrado em 15/09/2026; antigo `105268…` aposentado |
| Marca `sapore` + tenant `cognita-homologacao` | Verde | `.local/pilot.json` |
| Allowlist com 3 testadores | Verde | `.local/pilot.json` (labels; números não documentados aqui) |
| `CHANNEL_ENABLED` local = false | Verde | `.local/database.env` / `vps-database.env` (5 chars → `false`) |
| `KAPSO_API_KEY` na VPS | Verde | `/opt/sapore-sdr/secrets/kapso.env` + `runtime.env` (64 chars); containers recreados |
| `responsibleUserId` Kapso | Verde | Canal `1052683654599692` com responsável no banco (`has_responsible=true`, `enabled=false`) — 15/09/2026 |
| `adminUserIds` Supabase Auth | Verde | `admin=1`, `reviewer=1` ativos em `sdr.memberships` |
| Testers na allowlist (DB) | Verde | `testers=3` em `sdr.testers` — seed SQL aplicado 15/09/2026 |
| Functions Kapso (`session` / `dispatched` / `handoff`) | Verde | Criadas, deployed; secrets `SAPORE_API_URL` + tokens configurados |
| Workflow Kapso draft | Verde | `a2c54a90-1654-495b-b586-49066507f142` — status draft |
| Trigger inbound no número | Verde | `1585eae8-…` **active=true** (duplicata `7875a8ad-…` desativada) |
| Webhook backend no número | Verde | `https://sdr-api.cognitaai.com.br/webhooks/kapso` ativo |
| Runtime mode | Verde | `EXECUTION_MODE=whatsapp`, `CHANNEL_ENABLED=true`, health/ready 200 |
| `NATIVE_CONTROL_VERIFIED` | Amarelo | `false` de propósito: Decide → handoff nativo até prova Resume |
| Envio automático da IA | Bloqueado pelo gate | `outboundEnabled=false` até `NATIVE_CONTROL_VERIFIED=true` |
| Ping interno | Pronto para teste | Mandar WhatsApp de um testador da allowlist para `+1 318-612-9308` |

## Sequência segura (não pular)

### A — Credencial (você, fora do chat)

1. Revogar qualquer chave que tenha passado por conversa.  
2. Gerar chave nova.  
3. Colocar **somente** na VPS / gerenciador de secrets: `KAPSO_API_KEY`.  
4. Responder aqui: `chave na VPS: sim` + `chars: N` (sem valor).

### B — Pré-voo Kapso (na VPS, com env carregado)

Rodar o script (não imprime a key):

```sh
cd /caminho/sapore-sdr
chmod +x scripts/kapso-preflight.sh
./scripts/kapso-preflight.sh
```

Ele confirma: número, webhooks (contagem), workflows (contagem).  
Se houver mais de um consumidor respondendo no mesmo número → **parar** e resolver duplicidade.

### C — Operador humano

1. Resolver `responsibleUserId` na Kapso (Gabriel Lima / operador do Inbox).  
2. Preencher em `.local/pilot.json` **na máquina**, não no chat.  
3. Criar usuários de homologação no Supabase Auth e listar IDs em `adminUserIds`.  
4. Rodar seed: `node --env-file=... --import tsx scripts/seed.ts` (não habilita envio).

### D — Teste interno (ainda com `CHANNEL_ENABLED=false` até o gate)

1. Capturar Handoff/Resume reais e fechar o matcher.  
2. Só então `NATIVE_CONTROL_VERIFIED=true` **e** teste com allowlist.  
3. Um ping para testador autorizado.  
4. Opt-out + handoff + “não envia sugestão sozinha” validados.  
5. Liberar `CHANNEL_ENABLED=true` só com autorização explícita.

## Fora deste recorte

Dashboard React, RD CRM, agenda, métricas de piloto e anúncios Meta.  
O agente no WhatsApp é o core; o front passa a **ler** conversas depois.

## Critério de “podemos testar na prática”

- Chave Kapso válida **só** no servidor  
- Número `1052683654599692` inventariado, sem workflow duplicado  
- Allowlist + responsável definidos  
- Um envio interno bem-sucedido com handoff humano  
- Gates documentados ainda fechados para lead de anúncio
