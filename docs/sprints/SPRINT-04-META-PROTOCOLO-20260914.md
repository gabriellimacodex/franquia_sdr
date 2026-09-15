# Sprint 4 — integração local do protocolo de campanha

Checkpoint de 14/09/2026, 00:58:38 UTC. **Implementado e verificado localmente; não publicado, não é campanha paga nem aceite do sprint.** O turno anterior respondeu apenas ao pedido de status, sem implementação. Esta continuação retomou o trabalho seguro e produziu o protocolo integrado descrito aqui.

## Entrega

- `sprint4-admission-v2` separa admissão prévia (teto e validade do envio) de medição posterior (job/deadline, tentativa, payload preparado, reserva e liquidação). A ação `dispatch-once` contém o DTO `campaignAdmission` consumido pelo SEND existente. Não exige nem inventa um payload/deadline antes da criação do job.
- O controller grava a intenção por CAS antes de disponibilizar o envio. ACK perdido ou ação expirada não autorizam reenvio após reinício. T2 depende da conclusão auditada de T1 na mesma sessão; os 66 turnos candidatos precedem os seis M6 com publicação própria.
- Recibos distinguem criação, preparo, terminal e ambiguidade. Reserva medida deve respeitar fórmula e teto; custo deve respeitar a reserva medida, não apenas o teto maior. Evidência incompleta, prazo impossível, falha ou estado contraditório interrompem a sequência. Deadline do job não é confundido com validade do envio ou horário posterior da auditoria.
- A retomada confere identidade/versão, request, job, reserva e dependências entre sessões. A revisão independente reproduziu três lacunas nessa conferência; cada uma recebeu teste RED→GREEN e nova revisão, sem atribuí-las a falhas observadas em produção.
- Journal SQLite mantém `user_version=1`, revisões append-only, CAS entre processos, permissões privadas e recuperação após SIGKILL. O protocolo versiona o conteúdo, não a tabela. Histórico legacy continua legível/auditável, mas não aceita CAS, upgrade, reset ou novos envios. Bytes históricos foram comparados antes/depois das recusas.
- Auditor terminal usa uma única consulta scoped READ ONLY. Confere evento de admissão, marcador/hash, identidade, versão, dupla run/turn, prazo do envio e reserva real. Impede downgrade para legacy de um job admitido. Saída v2 acrescenta medição e deadline reais, mas continua `terminal-observation`, `objectiveAudit=pending`, `humanReview=pending`.

Não houve alteração em `src`, migrações, dependências, frontend, workflow, serviços remotos, acessos, modelo ou orçamento neste recorte. Os cinco arquivos da admissão runtime do checkpoint anterior mantiveram os mesmos hashes. Essa admissão runtime também permanece posterior à imagem r8 publicada.

## Verificação

| Recorte | Evidência |
| --- | --- |
| Controller e contratos | 24/24; 12 testes anteriores migrados para o requisito explícito de admissão, 12 testes novos. Foram preservados CAS, replay, histórico de falhas, pins, capacidade, T2 e gates humanos. |
| Journal | 12/12, incluindo nove regressões anteriores; um RED→GREEN funcional e duas novas regressões. |
| Auditor | 23/23; 14 testes legacy preservados, sete RED→GREEN funcionais e duas regressões adicionais. |
| Integração entre componentes | 1/1 com SQLite durável + PGlite, snapshot financial-v2, SEND/claim/Engine/auditor reais e transporte/callback simulados. TypeScript corrigido por estreitamento dos tipos reais da resposta, sem casts que escondam `unknown`. |
| Consolidada | **414/414 + TypeScript**, zero falhas/skips/cancelamentos; 67 arquivos de teste. Início 00:57:31.415 / fim 00:58:38.306 UTC; testes 64,377548167 s. |

As contagens dos recortes estão incluídas na consolidada; não somá-las novamente. O primeiro teste integrado já passou funcionalmente, portanto é regressão de composição, não um ciclo RED funcional inventado. Antes do GREEN do auditor houve um erro de FK no fixture da duplicação; o fixture foi corrigido antes da reprodução válida da falha. Os três achados de revisão do controller tiveram reproduções independentes repetidas após a correção.

Artefatos da consolidada:

- [TAP integral](SPRINT-04-META-ADMISSAO-REGRESSAO-20260914T005731415Z.tap), SHA-256 `54458a66d7d8ade2c42e9f96b8a0b2bf09f47b83525fc6385b3e547544e404cc`.
- [Metadados e manifesto](SPRINT-04-META-ADMISSAO-REGRESSAO-20260914T005731415Z.json): 143 arquivos, hash `194e2688bfb26e292fa68280077e4b0e542c05aa19a1ddeb0797e7e01c71ae7b`; todos os hashes reconferidos pelo principal depois da execução, zero diferenças.
- Logs `.types.log` e `.stderr.log` adjacentes preservados. O coletor terminou com exit 0; não reiniciar essa execução para responder status.

Matriz determinística renovada depois do freeze: [60/60](SPRINT-04-META-DETERMINISTICA-20260914T005912800Z.json), 00:59:12.800→00:59:21.662 UTC, zero violações críticas/rede/modelo/custo. SHA-256 `bca9f84c4493934b8ed5bca95b61a783197b505a0a3c08e479c1020fa1f42bde`; manifesto `6d502e163cf99c7d1d3866c701c2fa08a8b6c66e06e12fa539569e1f025f3b2a`. O snapshot/hash/modelo candidato continuam os mesmos; essa é evidência local, não registro administrativo ou avaliação de conversa paga.

## O que o teste integrado não prova

O port de prontidão é uma fixture, não autenticação HTTP ou verificação do ambiente remoto. `modelPosts` conta uma chamada ao transporte simulado, não uma execução paga do modelo. Callback e usage são fornecidos manualmente. `financialReply:null` cobre compatibilidade do contrato v2, não a qualidade do ramo financeiro. O corpo HTTP não é inspecionado nesse teste; a cobertura de transporte pertence aos testes próprios.

A reserva local única foi liquidada em 400 microUSD sintéticos, **zero gasto real**. Fechar/reabrir o journal não duplicou o envio. O auditor leu os registros efetivos locais; tentar registrar sua observação diretamente como Receipt foi rejeitado. A campanha permaneceu aguardando avaliação objetiva; nenhuma nota, validação humana, publicação ou liberação de T2 foi fabricada.

## Continuidade e limites

Próxima tarefa segura: conectar as verificações de prontidão/ambiente e a avaliação objetiva ao executor real, com artefatos privados e tratamento explícito de falhas/ambiguidade; completar o planejamento de custo e contexto T2 antes da campanha. Não preencher os booleanos de revisão ou notas por existir uma fixture verde. Preparar e verificar o pacote integrado exato antes de publicar o runtime da admissão.

Continuam pendentes: autorização específica de admin de Gabriel, novo login/QA autenticada e papéis, campanha conversacional 30×2 e notas humanas, publicação financeira, M6, validação pessoal de João e aceite comercial de Gabriel. A proposta de infraestrutura é um gate separado ainda não autorizado. A meta permanece ativa, sem flexibilizar critérios.

Não houve nova leitura remota neste recorte. Última fotografia permanece **00:27:41.083043 UTC**: 359.814 usados / 640.186 disponíveis no gate original de 1.000.000 microUSD; 31 settled, zero pending/unknown e zero jobs ativos/canais/deliveries. API/worker r8 e frontend v10 são as últimas publicações verificadas, não equivalentes a esta árvore local.

TDD, contratos tipados e revisão independente orientaram a separação das evidências e a correção das três lacunas de retomada. As orientações Supabase mantiveram a leitura scoped, privada e somente leitura, sem migração ou mudança de privilégio. Documentação consultada: [transações READ ONLY do PostgreSQL](https://www.postgresql.org/docs/current/sql-set-transaction.html) e [RLS no Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security). O changelog foi consultado via página HTML após falha de leitura do índice Markdown; nenhuma alteração relevante de API Supabase foi implementada neste recorte.
