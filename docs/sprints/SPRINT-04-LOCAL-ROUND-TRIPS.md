# Sprint 4 — S4.10: viagens ao banco no preparo e na conclusão

Estado: **IMPLEMENTADA E VERIFICADA LOCALMENTE — 11/09/2026**. Após “VAMOS EM FRENTE”, esta micro meta reduziu viagens ao banco no preparo e na conclusão. **207/207 testes e TypeScript aprovados**, revisão independente sem achado material. Não houve publicação, consulta ao ambiente remoto do projeto, chamada paga ou aceite de latência nesta etapa.

**Atualização posterior:** o [gate remoto S4.10](SPRINT-04-ROUND-TRIPS-GATE-20260911.md) foi autorizado e executado separadamente: r5 publicada, 187 testes do pacote isolado e 44 da imagem aprovados. Duas chamadas deram 19,547/16,784 s E2E, sem aceite de fluidez; uma paráfrase ambígua da memória também foi reprovada, apesar dos dados e controles íntegros. O texto abaixo preserva as evidências e limites da etapa local, não o estado remoto atual.

## Alterações

### Preparo

`Engine.prepare` agrupa a leitura do snapshot, do lead e das últimas 24 mensagens: **três consultas → uma**, dentro do mesmo `scoped`. As datas projetadas em JSON são normalizadas para ISO, preservando as validações existentes. A recuperação de conhecimento permanece separada.

### Conclusão

- Insere em lote somente `result.bubbles`, depois do guard e da reconciliação aplicável: saída aprovada ou fallback seguro, nunca os balões brutos rejeitados. Preserva IDs e ordem.
- Nos resultados `continue`/`nurture` do laboratório, grava diretamente `completed`, eliminando `ready` → `completed` dentro da mesma transação. Handoff/stop/rejeição continuam `handoff`; WhatsApp continua `ready`, sem gravação local de resposta.
- Com zero balões, não executa o `INSERT` de mensagens.
- Preserva as transações e a ordem de locks **job → conversa → candidato**, além da liquidação de orçamento e do rollback. O ledger não é reiniciado.

Não há alteração de frontend, modelo, prompt, n8n, regras comerciais, limites de saída ou ativação do financeiro v2. Os gates e controles existentes permanecem exigidos.

## TDD e evidências

Na conclusão, foram executados três ciclos RED → GREEN, um caso por vez: inserções de dois balões **2 → 1**, escritas de estado **2 → 1** e caso vazio com **zero inserções**. Duas regressões adicionais passaram: rollback na colisão do ID do segundo balão e rollback após erro na liquidação do orçamento.

No preparo, um ciclo RED → GREEN demonstrou **7 → 5 consultas** na contagem do teste. Duas regressões adicionais passaram: colisões de IDs entre tenants/marcas e entradas ausentes/inválidas sem sobrescrever o contexto anterior. O teste principal preserva as últimas 24 mensagens, papéis, timestamps com fuso/microssegundos e fontes canônicas.

A conclusão antiga também foi reexecutada em cópia isolada: **15 consultas, uma transação e 2.550 ms simulados**, falhando na asserção de escrita única como esperado. A conclusão atual usa **13 consultas, uma transação e 2.250 ms simulados**. O relógio contabiliza BEGIN/COMMIT; é uma simulação de RTT sobre consultas executadas em PGlite, não benchmark de banco remoto.

Três expectativas legadas de contagem foram atualizadas por mudança explícita do requisito: callback simples de um balão sem liquidação **12 → 11**, e dispatch **16 → 14** em dois testes. As contagens continuam exatas; as asserções de privacidade, telemetria, replay e transações não foram relaxadas. A revisão independente do diff integrado não encontrou achado material; a rodada final de regressão passou.

Seis regressões de controle, adicionadas e executadas uma por vez, passaram: continue com Unicode/quebra de linha; nurture; handoff; stop; rejeição com fallback público e evidência privada; WhatsApp mantido em `ready` sem mensagem local, delivery ou reserva laboratorial. Todos os ramos laboratoriais testados preservaram liquidação fictícia de 403 microUSD; nenhum provedor foi chamado de verdade. Esses seis testes são regressões, não seis novos ciclos RED atribuídos à otimização.

Uma falha auxiliar no novo teste usava a coluna inexistente `deliveries.id`; foi corrigida para a coluna real `job_id`, sem relaxar a asserção de zero deliveries. A falha RED original de dois INSERTs versus um havia sido demonstrada antes dessa correção do teste.

| Cenário controlado | Antes | Depois | Natureza da medida |
| --- | ---: | ---: | --- |
| Preparo | 1.350 ms | 1.050 ms | Relógio simulado, RTT de 150 ms |
| Conclusão com dois balões | 2.550 ms | 2.250 ms | Relógio simulado, RTT de 150 ms |

O caminho laboratorial com dois balões elimina **quatro viagens ao banco por turno** nesses cenários: duas no preparo e duas na conclusão. Esses valores são **simulados**, não medições remotas ou E2E; não demonstram que a meta de 8 s foi alcançada, nem estabelecem SLA ou economia equivalente na interface.

## Verificação final

| Verificação | Estado |
| --- | --- |
| Ciclos RED → GREEN e regressões pontuais descritos acima | Aprovados |
| Suíte completa e TypeScript | **207/207 + TypeScript**, `npm run build && node --import tsx --test --test-concurrency=4 tests/*.test.ts`; Node v24.13.1; 62,251 s de suíte, não benchmark do produto |
| Revisão independente do diff integrado | Sem achado material; somente preparo e conclusão alterados no código |
| Publicação, QA remota e chamadas pagas | Fora do escopo desta etapa |

São **14 testes novos**: cinco de conclusão/round trips, três de preparo e seis de controles. A primeira rodada teve 203/203 enquanto o arquivo de controles ainda crescia; a rodada final foi executada com os seis casos congelados. Único aviso observado: depreciação preexistente de `disableRequestLogging` no Fastify. Nenhum pacote ou lockfile alterado. A redução de consultas não autoriza relaxar controles ou declarar a fluidez resolvida.

Código alterado apenas nos blocos `Engine.prepare` e `Engine.complete` de `src/engine.ts`, hash local **`ed80fde91249652693e389d237d4aeaa72bd4df710c668312342f586f8917c0f`**. Testes novos: `prepare-read-batch.test.ts`, `completion-round-trip.test.ts`, `completion-controls.test.ts`; contagens existentes em `engine-timings.test.ts` e `preflight-round-trip.test.ts`. A suíte contém financeiro v2 preexistente e confirma compatibilidade local, **não sua publicação ou ativação**. O frontend não foi modificado nem revalidado.

`Database.scoped`, worker, claim/leases/deadlines, preflight, pool e migrações ficam intactos. A inspeção do worker confirmou que o briefing do laboratório já retorna antes de consultar o banco; retirar a espera de 1 s ou paralelizar o ciclo aumentaria carga/riscos sem ganho demonstrado nesta etapa. Agrupar a configuração RLS com leituras de domínio foi descartado neste recorte para preservar a ordem de segurança. As orientações de TDD, Supabase/Postgres e contratos tipados guiaram a mudança limitada, sem nova abstração ou relaxamento de erros/validações. Referências técnicas consultadas: [transações no node-postgres](https://node-postgres.com/features/transactions) e [locks transacionais no PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## Referência remota histórica

A última referência informada, às **20:37 UTC de 11/09/2026**, é API/worker r4, frontend v8, **28 reservas**, **326.068 microUSD utilizados** e **673.932 disponíveis**. Esse estado **não foi reconsultado nesta rodada** e não garante saldo ou saúde atuais.

O gate `sprint3-continuous-20260910`, a cota de 1.000.000 microUSD e o teto total autorizado de R$ 10 permanecem como limites, sem reset ou ampliação inferida. WhatsApp/Kapso continuam fora do escopo. Nova publicação ou bateria paga depende do gate correspondente; esta micro meta executa somente trabalho local.

## Gate proposto na etapa local, executado posteriormente

Publicar somente estes blocos de otimização na API/worker, partindo da r4 e preservando-a para rollback; **não empacotar integralmente a árvore local financeira**. Manter site v8, n8n, modelo/prompt/hash comercial, orçamento e canais inalterados. Antes de ativar, validar o pacote/imagem isolados e reconsultar saldo/pendências. Eventual bateria de até duas chamadas fictícias exige autorização específica e deve medir E2E comparável sem retries para buscar resultado favorável.

**No fechamento local, publicação e aceite remoto estavam pendentes.** A publicação e a QA foram executadas depois no gate vinculado no topo, sem aceite de fluidez/condução. A meta de 5 s típicos/até 8 s na bateria não foi comprovada. As reduções simuladas são incrementais; não justificam afirmar que bastarão para alcançar essa meta. Sprint 4 permanece aberto, assim como financeiro v2, reviewer, mobile autenticado, logout/retomada e aceite comercial final.
