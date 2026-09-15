# Sprint 4 — controlador da campanha, somente local

11/09/2026. **Não é runner conectado nem campanha executada.** Usa o [plano fixo](SPRINT-04-META-PLANEJADOR-LOCAL.md); nenhuma chamada, reserva, nota humana ou aprovação foi criada.

Arquivos novos: `evaluations/sprint4-controller.spec.ts`, `evaluations/sprint4-controller.ts`, `tests/sprint4-controller.test.ts`. Não entram no pacote r7.

## Garantias e dependências

O comando `next` valida o plano canônico, lê o journal e pede evidência atual por uma porta injetada. Exige admin real, escopo de laboratório, versão/hash/modelo exatos, sessão própria e pronta, saúde, controles fechados, orçamento e capacidade de 100 mensagens/24h. O custo de reserva usa o bound exato informado pela porta; projeções antigas do planejador não bastam. Runtime continua responsável por checks atômicos no envio efetivo.

Antes de devolver uma única ação de envio, grava a intenção por compare-and-swap (CAS). O journal deve ser **durável e compartilhado entre processos**, confirmar somente depois do commit e nunca apagar/reiniciar evidências. Reinício, concorrência ou ACK de commit perdido não libera uma segunda ação enquanto a intenção permanecer sem conclusão auditada. A ação expira no menor prazo entre preflight e deadline do job; o futuro executor deve respeitar UUID, uso único e validade.

`record` vincula recibos à intenção/sessão/versão/job/reserva, impede reutilização entre turnos e trata replay equivalente sem nova gravação. ACK de aceitação não é conclusão: T2 depende de resultado terminal auditado de T1. Falha crítica, guard reprovado, custo acima da reserva ou resultado ambíguo interrompem. Uma confirmação tardia não apaga timeout nem reabre automaticamente a campanha.

R1 e R2 antecedem M6, que ainda exige evidência de publicação. Concluir o registro da sequência retorna `acceptance=pending`; recibos são entradas confiadas ao adaptador, não prova de sua própria verdade, e auditoria objetiva não é nota ou aceite humano.

## Verificação e limite de uso

Doze ciclos RED→GREEN, **12/12 testes do controlador e 19/19 com o planejador**, TypeScript aprovado. O ajuste final testou deadline 1.500 versus validade 2.000 e devolve 1.500 preservando a evidência original. A sequência de 72 ações foi testada com recibos fictícios explícitos, sem conexão ao laboratório/modelo.

Atualização de 13/09: [journal durável local](SPRINT-04-META-JOURNAL-LOCAL.md) implementado com nove testes e [observação terminal somente leitura](SPRINT-04-META-AUDITORIA-TERMINAL-LOCAL.md) com 13 testes/revisão independente. Ambos estão na integração local de319/319, não no pacote r7. A observação não é recibo aprovado e não revalida notas humanas.

Ainda necessários: integração segura dos adaptadores, preflight real, executor de uso único e auditoria objetiva/coleta privada; admin autorizado; campanha/bounds completos e capacidade atual; notas humanas e QA publicada. A revisão adicional de Hume não terminou por limite de uso e não conta como aprovada. Não executar o controlador com um journal em memória em uma campanha real nem tratar os testes como 72 chamadas realizadas.
