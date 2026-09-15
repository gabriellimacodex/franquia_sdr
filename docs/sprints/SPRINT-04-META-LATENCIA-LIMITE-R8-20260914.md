# Sprint 4 — limite condicional da r8 para M6

14/09/2026 UTC. Revisão somente leitura da **r8 congelada**, não da árvore posterior em alteração. Não houve nova simulação, chamada ao modelo ou mudança de infraestrutura. A publicação r8 corrige integridade/recuperação; **não comprova M6**.

## Evidência e contabilidade

A r8 incorporou preparo e conclusão agrupados. No cenário comum com fatos/relação, a contabilidade é aproximadamente **50 viagens PostgreSQL**: envio autenticado 13, descoberta/claim 6, preparo 9, ACK 4, callback 13 e detalhe autenticado 5. Não inclui todos os polls/ciclos ociosos; inclui sobreposições, portanto não deve ser multiplicada e apresentada como E2E medido.

O recorte sequencial mais conservador considera somente envio, preparo e callback: **35 viagens dependentes do turno**. Sob a hipótese explícita de RTT uniforme de 136,984 ms:

- Transporte dessas etapas: 4.794,440 ms.
- Mais provedor artificial de 3 s: 7.794,440 ms, antes das parcelas omitidas.
- Mais provedor artificial de 5,5 s: 10.294,440 ms.

São limites **condicionais dessa arquitetura e do RTT assumido**, não uma medição nova, distribuição futura ou prova de impossibilidade de qualquer reescrita. Auth HTTP, fila, descoberta e renderização continuam fora desse cálculo. O intervalo do provedor real varia e não é inferência pura.

Para caber em 5 s com provedor de 3 s nesse RTT, sobraria espaço para no máximo 14 viagens críticas, ainda desconsiderando todas as outras despesas. Remover somente poucas escritas, acordar o worker ou sinalizar a conclusão não oferece margem demonstrada.

O [artefato anterior da integração](SPRINT-04-META-LATENCIA-FUSED-20260913.json) é consistente com a limitação: commit em 9,257/12,184 s e detalhe em 9,682/12,605 s. São simulações com provedor 3/5,5 s, não resultados publicados de M6. Com RTT artificial de 10 ms, o detalhe ficou em 5,278/7,833 s, ainda com Auth/ACK zerados e sem navegador; aproximar os serviços também não garante o aceite sozinho.

## Decisão e próximo experimento

Não repetir chamadas pagas ou micro-otimizações isoladas para alegar 5/8 s com essa hipótese insuficiente. As frentes independentes de segurança, campanha financeira e QA continuam abertas, respeitando seus próprios gates; este diagnóstico não encerra o sprint nem justifica transferir M3 para outro sprint.

Hipótese falsificável: executar o mesmo runtime mais perto do **mesmo banco** pode remover a maior parcela do custo serial. Antes de qualquer mudança real, é necessário identificar uma opção concreta, apresentar escopo/custo/risco/rollback e obter autorização específica; a meta não autoriza contratação ou migração por inferência. A verificação deve medir RTT, autenticação, commit e descoberta com margem, mantendo modelo, contratos, fontes, controles e cota. Só a bateria real completa pode aprovar M6.

Alterar o critério de aceite é outra decisão exclusiva de Gabriel; não foi presumida nem recomendada como conclusão automática. Nenhuma opção de infraestrutura foi contratada, nenhum dado migrado e nenhum modelo trocado.

## Base revisada

Pacote `/tmp/sapore-s4-ack-final.3Cx3Sr/sapore-sdr`, correspondente à r8 publicada. Fontes principais: `src/lab-sessions.ts`, `src/laboratory-dispatch.ts`, `src/engine.ts`, `src/database.ts`; [integração e método](SPRINT-04-META-DISPATCH-INTEGRADO.md), [diagnóstico anterior](SPRINT-04-META-LATENCIA.md). Contagem independente revisada com o responsável principal. Não confundir a baseline antiga de 61–63 viagens com o recorte atual de 50.
