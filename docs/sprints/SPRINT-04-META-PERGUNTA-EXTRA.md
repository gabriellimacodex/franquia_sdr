# Sprint 4 — reparo delimitado de pergunta extra

Atualização de 13/09/2026: reparo incluído na [r7 publicada](SPRINT-04-META-RUNTIME-V2-PUBLICACAO.md), com 238/238 testes do pacote e da imagem. **Ainda não homologado com modelo.** Este reparo não comprova o fechamento do caso histórico completo nem do Sprint 4. As evidências locais de 11/09 estão preservadas abaixo.

## Falha e limite de evidência

A sessão histórica `05a61e` pausou por `multiple_questions`, conforme [auditoria M2](SPRINT-04-META-M2-PUBLICACAO.md). O modelo perguntou “Osasco, certo?” e, em outro balão, quem tocaria a operação. Conhecemos os balões privados rejeitados, mas não as propostas/relações/referral originais; não reconstruímos esses campos como evidência histórica.

Por isso, a reprodução usa explicitamente uma **fixture sem extrações**. Não se afirma que o callback antigo inteiro seria elegível. Em especial, aceitar uma proposta `city=Osasco` enquanto a confirmação de “Osaso” ainda é uma pergunta poderia gravar uma interpretação não confirmada.

## Mudança e preservações

`src/question-reply.ts` executa o guard original e somente tenta reparo quando:

- Canal de laboratório, lead ativo e ação continue; sem nova proposta, relação ou indicação.
- A única violação original é `multiple_questions`.
- São dois balões, cada um com uma única pergunta terminal, sem citações tipográficas/aspas duplas ou URL.
- O segundo balão é inteiramente a pergunta reconhecida sobre operação pessoal versus gestor/parceiro, com prefixo opcional “Pra/Para eu te orientar melhor”. Não há resposta independente ou outra afirmação nesse balão.

O primeiro balão fica literalmente igual. Somente o segundo é removido **deste turno**; não há agendamento automático dessa pergunta. Não remover pontuação nem converter a dúvida sobre cidade em afirmação. Esse é um padrão finito, não um reparador geral de perguntas ou linguagem natural.

A decisão proposta passa novamente pelo **mesmo guard completo** escolhido pelo snapshot imutável do job. No financeiro v2, só o ramo `financialReply=null` pode ser candidato e a revalidação ainda pode exigir o plano financeiro. Um plano preenchido, novas extrações ou outra violação mantêm o comportamento de bloqueio anterior. WhatsApp não recebe esse reparo.

`src/engine.ts` preserva checks de state/revisão/epoch/deadline e contrato antes do reparo; persistência, memória, mensagens e liquidação permanecem na mesma transação. Não há chamada adicional ao modelo, briefing pago ou delivery.

## Auditoria: não confundir reparo com acerto original do modelo

- Contexto privado do job: `guardReview.violations`, balões originais e `repairCode=deferred_operating_question` quando houver reparo.
- Evento técnico: guard final aprovado, `modelGuardPassed=false`, `originalGuardViolations` e `replyRepair`; sem os balões privados.
- DTOs de tester/reviewer não recebem o contexto bruto. Em avaliações, a falha original deve continuar registrada; não contar a resposta original como aprovada só porque o backend a reparou.

## Verificação local

Dois ciclos RED→GREEN: primeiro o helper recusava a fixture elegível; depois a integração ainda pausava como human. Sete testes unitários e três de integração aprovados. Incluem resposta comercial com fonte preservada literalmente, resposta independente no segundo balão não removida, propostas/relações/referral bloqueando reparo, controles, contrato v2, execução dupla do guard, idempotência, privacidade, cobrança única, rollback de liquidação e quatro causas de callback stale.

Subset com controles de conclusão e contrato financeiro: **19/19**. Revisão independente: sete testes unitários executados e inspeção de integração/DTOs, sem bloqueador. Árvore completa final: **249/249**, 35,521080167 s, TypeScript aprovado; Node 24.13.1, concorrência quatro. O aviso preexistente de depreciação de `disableRequestLogging` do Fastify continua sem mudança de dependência.

Hashes locais:

| Arquivo | SHA-256 |
| --- | --- |
| src/question-reply.ts | 54afed52b24dae46ae26e595b8107858bd3d0af8478d6585305364f64b1674c1 |
| src/engine.ts | 87860bd54a18f0e6797678fa8ac958f7f29d88eda1de08138cbac064c3487fb8 |
| tests/question-reply.test.ts | 2dc7204137f924410abbf3d8479b3020d91f7f6eedcb418df7f7eb28be64af63 |
| tests/engine-question-reply.test.ts | 35b9ad1cdc22aa588225608de4fc2691c92a9843e4a8f1a88589efdad93dbfdd |

O hash de engine inclui o suporte financeiro v2; **não copiar esse arquivo isolado sobre a r6**. O helper importa o contrato financeiro. O pacote compatível foi posteriormente recortado, verificado e publicado como r7, preservando legado e rollback; não foi publicada a árvore inteira.

Na implementação local de 11/09 não houve operação remota ou chamada paga. A publicação ocorreu em 13/09; QA com modelo, latência e aceites continuam pendentes.
