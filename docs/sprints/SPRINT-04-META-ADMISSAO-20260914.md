# Sprint 4 — admissão conservadora da campanha, somente local

14/09/2026 UTC. Implementação revisada pelo responsável principal, **fora da r8 publicada**. Não houve nova chamada paga, mudança de schema, usuário, modelo, n8n ou cota. A integração controller/journal/runner permanece pendente; este trabalho não libera a campanha real.

## Contrato e fiscalização

Antes do SEND, o contrato aceita apenas `runId/turnId`, versão/hash/modelo fixos, prazo da submissão e `maxReservationMicroUsd`. Não aceita como prova payload exato ou deadline de um job futuro. Identidade vem da rota autenticada existente e de membership administrativa ativa no banco, não do campo `role` do chamador.

Na mesma transação do SEND, `LabSessions` grava o job, um evento privado `lab_campaign_admitted` e seu marcador no contexto. Evento inclui escopo, ator, sessão/request, candidato, job/revisão/epoch e o gate/cap originais. Usa o mesmo instante do banco para verificar a validade e registrar `created_at`. Falha de gravação ou expiração nesse ponto reverte mensagem, job, revisão e admissão juntos.

Replay deve repetir a mesma admissão; não pode omitir, acrescentar retroativamente, trocar ou ampliar teto/pins. Outro requestId com o mesmo runId/turnId também é recusado sob o lock existente. Controles gratuitos não criam uma admissão paga fictícia.

O coordenador carrega a evidência na consulta de orçamento existente, sem nova viagem no caminho normal. Antes de reservar/liberar o corpo, confere admin ainda ativo, propriedade, evento/marcador, sessão/request/job, versão/hash/modelo, revisão/epoch, gate/cap e validade da admissão quando criada. Prazo de submissão não substitui o deadline real do job.

O corpo efetivo continua sendo a mesma string medida em bytes UTF-8. Sua reserva deve caber **no teto do turno e no saldo global**. Ausência/corrupção de um dos registros, revogação ou teto insuficiente pausam localmente com código específico e zero POST/reserva. Contexto operacional fica privado, sem entrar no payload do modelo ou detalhe público. Callback, replay, controles e deadline permanecem sujeitos às regras existentes.

## Provas e limites

- **13/13 testes novos**, oito ciclos RED→GREEN e cinco regressões adicionais. O teste de corrupção reúne dez variantes, não dez ciclos independentes.
- Subset integrado antes da refatoração final: **76/76**, incluindo dispatch, recuperação, orçamento, Engine, sessões e avaliação existentes.
- Depois da refatoração do timestamp e remoção de cast: **13/13 + TypeScript** novamente aprovados pelo implementador.
- Responsável principal leu os cinco arquivos/diffs e confirmou seus hashes. Sem relaxar guards ou asserts anteriores. A consolidação compartilhada e a nova matriz terminaram aprovadas, conforme a seção final.
- PGlite usa banco local efêmero; POST/callback são simulados. A falha após INSERT comprova rollback transacional da fixture, não uma falha real de rede no COMMIT. As provas PostgreSQL anteriores de reserva/claim continuam independentes.
- O fingerprint verifica consistência entre evento e marcador. Não é assinatura contra um administrador de banco capaz de apagar ou regravar ambos.
- Teto por turno + gate global **não demonstram que a campanha inteira cabe no saldo**. Custos T2, plano restante, capacidade diária, autenticação real, gates de versão e notas/aceites humanos ainda precisam ser comprovados.

## Arquivos congelados desta microetapa

| Arquivo | SHA-256 |
| --- | --- |
| `src/campaign-admission.spec.ts` | `b4b276b757fe9f611ba4a8d7c950fbf851677b0a5a17980cd1bb6fbc91dd3a1b` |
| `src/lab-sessions.ts` | `f02c658a39894c8556bb9d5fc63e75ea68ec15db7fc628aa5ff9f89505c33d8f` |
| `src/laboratory-dispatch.spec.ts` | `1a075c14c19f976c002ada2022537c383075593b90e9a6eaa6c04788766a6176` |
| `src/laboratory-dispatch.ts` | `d36a8064469323adf3118fd93fa35a0e6af2ea6f212c49615a563ddd476d39fa` |
| `tests/campaign-admission.test.ts` | `d5b9d8d0c9ee455efdda3de381c9e1793e04e4242016a29a3be1d4e9270d5f3a` |

Adicionalmente, o auditor terminal local passou a aceitar uma recuperação gratuita anterior à primeira reserva, mas continua exigindo exatamente uma reserva vinculada à tentativa efetiva positiva: **14/14 + TypeScript**, um RED→GREEN e revisão independente. Não aprova automaticamente conteúdo ou notas. O gerador de artefatos determinísticos recebeu apenas um ajuste de texto para não apontar permanentemente para a imagem r7.

## Próxima integração

Consolidação concluída às **00:38:35 UTC**: **389/389 + TypeScript**, zero falhas/skips/cancelamentos, 56.862,840791 ms. [TAP integral](SPRINT-04-META-ADMISSAO-REGRESSAO-20260914T003735773Z.tap), SHA `d9d6a3d257657d2e6634a6d0184ee92b88a2cf8bd411bf331bfbd6cbd7eaab45`; [manifesto/metadados](SPRINT-04-META-ADMISSAO-REGRESSAO-20260914T003735773Z.json), 141 arquivos, hash `b703cce4579b968f8b4f21cacd3fcdd2f60f38f90560329c86fb8c18959fd026`, fontes estáveis durante a execução e novamente conferidas depois.

Nova [matriz determinística](SPRINT-04-META-DETERMINISTICA-20260914T003847165Z.json), necessária após a mudança de runtime local: **60/60**, zero críticas, 00:38:47.165→00:38:56.313 UTC. SHA `07c9db6bf547a68b1d4edb6db45a7189c2554c8f3e8fc67adc354292a965fe75`, manifesto `e112300751c395a32458832c8081b4575637617b2b6a0c7ec86c2e0512b04e73`. Mesmo snapshot e modelo fixados; zero rede/modelo/custo. Não é avaliação conversacional, publicação financeira ou M6. As rodadas anteriores permanecem preservadas.

Separar a admissão pré-SEND da medição após criar/preparar o job no controlador e no journal, com contratos versionados e sem reinterpretar silenciosamente evidências antigas. Conectar prontidão somente leitura, autenticação independente, recibos com estados reais e auditoria da reserva efetiva. Preservar CAS, não reenvio após resultado ambíguo, ordem T1/T2 e gates humanos/financeiros. Só depois considerar pacote integrado e avaliação real planejada. Não publicar estes cinco arquivos isoladamente como se o runner já estivesse pronto.
