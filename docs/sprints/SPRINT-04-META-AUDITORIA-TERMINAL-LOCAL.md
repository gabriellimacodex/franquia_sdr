# Sprint 4 — observação terminal, somente local

13/09/2026. `evaluations/sprint4-terminal-audit.spec.ts` e `.ts`, testes em `tests/sprint4-terminal-audit.test.ts`. **Não é campanha executada, recibo aprovado, auditoria objetiva aprovada ou aceite humano.** Sem configuração de ambiente, transporte ou escrita remota padrão.

Uma SELECT parametrizada em transação somente leitura, junto de `journal.read`, cruza intenção canônica, scope, admin atual, sessão própria, entrada/request/job/candidata, versão/hash/modelo e proveniência de avaliação ou publicação para M6. Corrobora estado terminal, resposta visível persistida, guard, memória/projeções, reserva única liquidada, tentativa única, tokens e custo. Estados pendentes, expirados, falhas terminais, evidência incompleta ou contraditória não viram aprovação.

O resultado é `terminal-observation`, com `objectiveAudit` e `humanReview` obrigatoriamente `pending`. Não expõe snapshot, prompt/contexto completo ou telemetria. Falha de leitura retorna erro sanitizado, nunca ausência fictícia de problema.

## Evidência

13/13 testes, dez RED→GREEN e três regressões; SQL efetivo com PGlite, migrations de fixture e fluxo do Engine com provedor simulado. Revisão independente final sem bloqueador material. Integração compartilhada **319/319 + TypeScript**, 48,943954167 s, sem falhas/skips/cancelamentos.

Hashes SHA256: spec `4172df25e06db14cda8082ed373990d483101d06f51d4db6978b5a3f4543f63e`; implementação `e1d1e33e1e097f7548520acbb051ba19797aab446d5f4ded5cdac5fdf0cb6ab7`; testes `0d9ab326ac6b3d584de22283dd497c40c599269ef2e2e979d1d95285343b9e72`.

## Limites e próxima integração

Observar T1 antes de T2 ou controle mudar revisão/epoch: a memória atual não é snapshot histórico imutável. O ledger corrobora o backend, não comprova execução bruta independente do provedor, configuração remota ou saldo global. Timestamps do banco não comprovam commit nem renderização. A evidência de publicação M6 não revalida relatórios/notas humanas.

Permanecem necessários preflight real, transporte de uso único, integração com journal/controlador e auditoria objetiva; autorização administrativa, plano de custos completo, campanha real e revisão humana. Não converter a observação automaticamente em recibo nem usá-la para liberar chamadas.
