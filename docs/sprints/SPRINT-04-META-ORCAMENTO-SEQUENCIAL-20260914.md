# Sprint 4 — análise local de orçamento sequencial

Data: 14/09/2026. **Implementação local, sem publicação, chamadas de modelo, consultas remotas, alteração do ledger ou nova autoridade.** Este relatório não aprova a campanha nem afirma que ela termina no saldo disponível.

## Entrega delimitada

`Sprint4CampaignPlanner.analyzeBudget(raw)` foi acrescentado ao planejador existente. O método apenas delega ao utilitário puro `sprint4-campaign-budget.ts`, com contrato Zod/Result próprio. `execute`, `validate`, a matriz aprovada e os contratos anteriores do planejador permanecem inalterados. Não há transport, leitura de ambiente, relógio implícito, banco, admissão, reserva ou envio.

Arquivos do recorte:

- `evaluations/sprint4-campaign-budget.spec.ts`: entrada, relatório, erros e tipos.
- `evaluations/sprint4-campaign-budget.ts`: análise pura.
- `evaluations/sprint4-campaign.ts`: dois imports e um método delegante.
- `tests/sprint4-campaign-budget.test.ts`: dez testes locais.
- Este relatório.

## Uso e significado

O chamador fornece o plano canônico; um teto explícito para cada `turnId`; `asOf` e idade máxima aceita para as fotografias; fotografias datadas do gate existente e da janela móvel do mesmo ator; quantidade de vagas para mensagens de controle; observações de consumo; e referência T1 opcional. Não há teto por turno escolhido automaticamente nem um novo gate.

```ts
const analysis = planner.analyzeBudget({
  plan, ceilings, budgetSnapshot, dailySnapshot, consumption,
  asOf, maxSnapshotAgeMs, controlMessageSlots, historicalT1,
});
```

`historicalT1` pode ser `null`. Quando presente, recebe uma projeção explícita do artefato: `artifactSha256`, `kind`, `contentHash`, `model`, `localVersionId`, `observedAt` e os 30 `samples` com `caseId`, `payloadBytes`, `inputTokenBound`, `reservedMicroUsd`. O utilitário não abre o arquivo nem verifica o hash contra seus bytes; essa proveniência é responsabilidade do chamador. O teste lê e calcula o SHA do arquivo local real.

O relatório mantém `readyToExecute:false`, `inputSourcesVerified:false` e `requiresLiveRecheck:true`, mesmo quando as condições aritméticas estão satisfeitas. Os hashes vinculam o plano e os tetos normalizados; não comprovam autenticidade, autoridade, aprovação humana ou persistência imutável. Alterar um teto muda o hash do envelope, **não** modifica uma admissão já gravada.

- `totalCeilingMicroUsd` soma os tetos escolhidos; `remainingCeilingMicroUsd` soma apenas os turnos sem observação de consumo. Nenhum representa gasto real ou valor mínimo adicional necessário.
- `reportedSettledCostMicroUsd` soma somente custos liquidados informados. `retainedReservationsMicroUsd` mantém reservas `reserved`/`unknown` integralmente; custo desconhecido exige `null`, nunca zero fabricado.
- `availableGlobalMicroUsd` é exclusivamente `limitMicroUsd - accountedMicroUsd`. Os custos/reservas informados da campanha já devem estar nesse ledger; não são descontados novamente. A parcela informada não pode superar o total global.
- As observações devem formar um prefixo sem duplicação de turno/reserva. Uma pendência só pode ser a última observação. Isso valida a forma contábil, não o aceite objetivo; `nextUnobservedTurnId` é apenas um índice financeiro, jamais a próxima ação autorizada do controlador.
- `envelopeCoveredAtSnapshot` compara o saldo datado com o total dos tetos futuros. Se falso, não prova que o gasto efetivo será maior que o saldo; se verdadeiro, não protege contra consumo concorrente ou alterações posteriores da fotografia.
- A janela é de 100 mensagens em 24 horas móveis do mesmo ator. A próxima etapa é R1, R2 ou M6, com os turnos ainda não observados e as vagas explícitas de controle. O cálculo não determina uma data de reinício, não pressupõe virada à meia-noite e não troca de ator.

O relatório sinaliza parada financeira por fotografia vencida, reserva não liquidada, teto observado excedido, saldo sem cobertura do próximo teto ou janela insuficiente para a etapa mais controles. Mantém pendentes os payloads/deadlines reais, autoridade/pins, saúde do runtime/n8n, gates humanos/objetivos e ordem/auditoria do controlador. A ausência de motivos financeiros de parada **não libera envio**. Falhas críticas de qualidade/segurança continuam responsabilidade dos controles existentes, não são convertidas em sucesso por esta função.

## Referência histórica e exercício aritmético

O teste vincula o artefato [T1 de 11/09](SPRINT-04-META-T1-BOUNDS-20260911.json), observado em `2026-09-11T23:03:27.303Z`, ao snapshot `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959` e ao modelo `gpt-5.4-2026-03-05`. Verifica a cobertura exata C01–C30, `bytes + 4096`, a fórmula `ceil(bound × 2,5 + 1200 × 15)` e datas/pins. O UUID local da medição não é uma versão remota verificada.

| Quantidade | Soma das reservas de referência T1 |
| --- | ---: |
| 30 T1 medidos localmente | 1.748.758 microUSD |
| 60 T1, R1 e R2 | 3.497.516 microUSD |
| 63 T1, incluindo os três primeiros turnos M6 | 3.672.854 microUSD |

Os T1 individuais variam entre 58.168 e 58.490 microUSD. Os seis T2 da campanha, ou nove com M6 separado, continuam sem bound histórico medido. O relatório marca `sourceVerified:false` e `appliesToCurrentPayload:false`: mesmo os T1 não são previsões exatas do payload de um futuro job remoto. O hash do conteúdo comercial não comprova que todos os demais componentes do payload continuam iguais.

Nos testes, os tetos **fictícios e não aprovados para execução** são 70.000 por T1 e 100.000 por T2: R1 = 2.400.000, R2 = 2.400.000, M6 = 510.000, total = 5.310.000 microUSD. T2 recebe apenas uma restrição explícita, não uma estimativa de tamanho/custo. Nenhuma configuração publicada recebeu esses valores.

O exercício usa o saldo datado de 640.186 microUSD para mostrar que o próximo teto de 70.000 cabe na fotografia, mas o envelope completo não é coberto. Não houve nova consulta de saldo. A divisão desse saldo por 72 resulta em média efetiva máxima de aproximadamente 8.891,47 microUSD por chamada, sem outro consumo; isso é apenas uma condição aritmética, não uma previsão, e ainda seria necessário ter folga para cada reserva intermediária. Não foi calculado um “mínimo adicional” a partir da soma dos tetos ou das reservas T1.

## Evidência de desenvolvimento

Foram observados oito ciclos incrementais RED→GREEN:

1. Método ausente → relatório dos 66+6 tetos sem autoridade/custo inventado.
2. Tetos omitidos/duplicados/estrangeiros aceitos → cobertura exata rejeitando essas entradas.
3. Vínculo do envelope ausente → hashes estáveis do plano e dos tetos normalizados.
4. Consumo não suportado → separação de liquidação/reserva retida sem dupla contagem.
5. Consumo inconsistente aceito → validação de prefixo, identidade de reserva, custo, datas e total global; teto observado excedido sinaliza parada.
6. Resumo da janela ausente → datas, mesmo ator, limites exatos de saldo/capacidade e fotografia vencida.
7. Referência T1 não suportada → vínculo histórico validado sem fabricar T2 nem custo de execução.
8. Offset impossível aceito pelo formato `datetime` → refinamento compartilhado `Number.isFinite(Date.parse(value))`, cobrindo `asOf`, fotografias de orçamento/capacidade, consumo e referência histórica. O novo teste falhou primeiro com `asOf: 2026-09-14T01:00:00+99:99` aceito; depois rejeitou os cinco caminhos com `INVALID_INPUT`, preservando offsets válidos.

Duas regressões adicionais passaram: prefixo financeiro integral não aprova a campanha; cálculo usa somente tempo fornecido, não chama `fetch` e sanitiza erros. Não se atribui um RED a essas duas verificações já verdes.

Comando reproduzível local:

```sh
node --import tsx --test tests/sprint4-campaign-budget.test.ts tests/sprint4-campaign.test.ts
```

Resultado final do recorte: **17/17**, sendo dez novos e sete existentes, zero falhas/skips/cancelamentos. A primeira execução de `npm run build` encontrou somente dois erros concorrentes no teste HTTP em edição pelo responsável principal (`tests/sprint4-http.test.ts:115:38` e `126:38`, TS18048 sobre `init`). Nenhum erro foi reportado nos arquivos deste recorte nessa execução; a verificação global final continua com o responsável principal. Não foi rodada uma nova campanha determinística/global por esta subtarefa.

## Limites para a integração seguinte

O executor futuro deve fixar e preservar o envelope escolhido, carregar observações auditadas reais, revalidar saldo/janela/pins/autoridade antes de cada envio e usar o teto do `turnId` correto na admissão. O controlador/journal continuam responsáveis por idempotência, aceites e interrupções; o runtime continua responsável por medir o payload e fiscalizar o teto real antes de reservar/liberar o POST. Esta análise não altera esses componentes e não preenche `remainingCampaignReviewed` automaticamente.

O teto por turno e o gate global não demonstram que a campanha completa cabe no saldo. Continuam independentes: integração do executor, implantação autorizada do protocolo aplicável, administração real, avaliações conversacionais, notas/aceites humanos, publicação do snapshot e M6. Nenhum limite, requisito ou audiência foi ampliado por este recorte.

## SHA-256 do recorte de código

| Arquivo | SHA-256 |
| --- | --- |
| `evaluations/sprint4-campaign-budget.spec.ts` | `80dbcf27a5bca6723a45bfc284a5392c2802753fb9410ee5aa35d5ec4cec3f88` |
| `evaluations/sprint4-campaign-budget.ts` | `e882d33111941d7d3bacd769c972c3daaf908feb2410dc8c147a00f2ce401a9b` |
| `evaluations/sprint4-campaign.ts` | `75e31bc76b71050d650443506475f12eef081ee6486b429bb24e2260b35ef78a` |
| `tests/sprint4-campaign-budget.test.ts` | `6f003ca07fbe6ae223e01f66d59bb9083c18ce66ddafd07276d87d9f2e860dc7` |
| Artefato T1 de referência, sem alteração | `6fe2d59084037b48e95b0930dbd6975698dedffd5922a94a96025646a794327b` |
