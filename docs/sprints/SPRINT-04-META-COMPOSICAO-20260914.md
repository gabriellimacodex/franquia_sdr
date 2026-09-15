# Sprint 4 — composição privada e recibos vinculados

14/09/2026 UTC. **Entrega local, não campanha real, publicação ou aceite humano. Meta ativa; Sprint 4 aberto.**

Atualização posterior, **04:34 UTC**: a exigência retroativa de bruto discutida no final deste checkpoint foi corrigida conforme o plano original; a ausência continua explícita e O8 humano continua obrigatório. [Aplicabilidade e pacote runtime](SPRINT-04-META-ADMISSAO-PUBLICACAO-20260914.md), 572/572 + TypeScript. O restante deste relatório preserva a evidência e as limitações existentes às 04:23 UTC; não confundir seus 568 testes com a consolidação posterior.

## Resultado

`Sprint4Runner` conecta os componentes existentes de sessão, envio, arquivo terminal, revisão identificada e journal. Separa `advance` de `observe`: observar nunca envia; avançar exige que o recibo anterior seja rederivado a partir das evidências privadas. Uma intenção durável sem recibo continua impedindo reenvio. Não há loop pago, credencial descoberta automaticamente ou aprovação implícita.

O novo vinculador `Sprint4ReviewedReceipt` relê o arquivo terminal, o evento de revisão persistido e o conjunto O1–O8. A leitura autenticada do histórico foi acrescentada ao executor HTTP, sem escolher ou criar uma avaliação humana. Os julgamentos são selecionados explicitamente; notas nas quatro dimensões não equivalem a aprovação dos oito critérios. T1 permanece amostra parcial; T2 completa uma execução, não a campanha inteira. O aceite geral permanece `pending`.

Os contratos exigem releitura das provas, SHA, vínculo ao turno/arquivo/alvo/autor e ao próprio julgamento: status, notas e instante. Um hash isolado não autentica uma pessoa. **Os adaptadores operacionais que autenticam os avaliadores e verificam essas provas ainda precisam ser conectados; não foram substituídos por fixtures na operação real.**

## Proteções e revisões

- Um terminal concluído aguardando julgamento não é mais convertido em falha definitiva pelo controller. Falhas reais anteriores continuam bloqueantes, mesmo que apareça depois um recibo positivo.
- `expectedTurnId` passa do runner ao HTTP/controller e é conferido antes da inspeção e da intenção durável. Em conjunto com CAS, impede que uma mudança concorrente faça enviar o turno seguinte por engano. Chamadores anteriores sem esse campo permanecem compatíveis.
- Criação de sessão ambígua não é repetida; uma intenção já pendente admite uma tentativa de reconciliação somente leitura. O registro devolvido precisa corresponder ao plano, identidade, execução, modo e observação; T2 conserva a sessão anterior.
- O arquivo terminal é capturado antes da revisão. Uma prova ausente/adulterada impede novos envios, inclusive após reinício e recibo previamente positivo.
- Antes de `controller.record`, identidade, job, prazo, preparação e ledger do recibo precisam corresponder à observação capturada. A revisão independente encontrou que uma reserva igualmente trocada em dois campos poderia ser gravada; o teste reproduziu a lacuna e a correção rejeita antes de qualquer gravação.
- Achados negativos reais geram recibo negativo preservado no journal; ausência de julgamento/prova produz pendência, não aprovação. Nenhuma saída bruta foi inventada: `rawArtifactRef` permanece `null` quando indisponível. A revisão também corrigiu uma referência de prova indevidamente usada como referência de saída bruta.

TDD e contratos orientaram mudanças pequenas e verificáveis. RED→GREEN registrados nas novas fronteiras; os testes de falha histórica e perda de prova, cujas proteções já existiam, foram caracterizações GREEN — não se fabricou um RED alterando código correto.

## Evidência local

Focal final do runner: **17/17**, zero falhas/skips/cancelamentos, 3.982,294875 ms. São 14 unitários e três integrações. Revisão final independente aprovada sem bloqueador material adicional; a revisão não foi contabilizada como nova execução de testes.

As integrações usam Fastify, rotas reais, PGlite, migrations, Engine/callback e arquivos SQLite privados reabertos. Autenticação Supabase, provedor, prontidão, avaliação humana e provas são **sintéticos**:

1. C01: T1 enviado uma vez, arquivado e recuperado; revisão selecionada e ligada ao recibo; só então T2 na mesma sessão, sem duplicar mensagem/job/reserva. T1 permanece byte a byte igual após a memória avançar. T2 termina aguardando sua revisão.
2. O2 reprovado: recibo negativo persiste após reabrir SQLite; julgamento favorável posterior não apaga a falha nem envia T2.
3. Prova de recibo positivo removida ou adulterada: rederivação retorna pendência e nenhum novo envio é efetuado.

Histórico de correção da integração preservado: contrato inicialmente não aceitava `expectedTurnId`; fixture omitia `financialReply:null`; composição ainda não gravava recibo/avançava T2; teste consultava uma coluna inexistente de deliveries. Os ajustes não relaxaram o contrato financeiro nem a assertiva de zero deliveries.

A consolidação integral terminou: **568/568 + TypeScript**, zero falhas/skips/cancelamentos, **83 arquivos de teste**, `04:21:45.356→04:23:04.365 UTC`, 75.574,545917 ms de testes. Fonte estável durante a execução; manifesto de **179 arquivos**, hashes do manifesto/TAP e correspondência da árvore reconferidos após o término. Evidências: [metadados e manifesto](SPRINT-04-META-COMPOSICAO-REGRESSAO-20260914T042145356Z.json), [TAP integral](SPRINT-04-META-COMPOSICAO-REGRESSAO-20260914T042145356Z.tap), [TypeScript](SPRINT-04-META-COMPOSICAO-REGRESSAO-20260914T042145356Z.types.log).

Manifesto SHA256 `d766ac91ddf0a77795225a94d18bd661ab865b9efcb7d07c988bda2677710065`; TAP SHA256 `2d7609e35cb73055bb50d326c26264013a10b92d167f772fed8a21155a937a58`. Comparação com a consolidada 530 confirma **sete arquivos novos e seis anteriores alterados**, todos em `evaluations/` e `tests/`. São 38 testes adicionais. Nenhum teste/build/deploy desta etapa ficou ativo. A matriz determinística 60/60 do checkpoint anterior não foi novamente executada nem apresentada como resultado novo; runtime financeiro e seu coletor não mudaram nesta fatia.

## Escopo e estado remoto

Mudanças limitadas a `evaluations/` e `tests/`: controller/HTTP alterados, vinculador/runner e testes adicionados. Nenhum `src/*`, schema, frontend, workflow, modelo, fonte comercial, snapshot, usuário ou orçamento alterado nesta etapa. Nenhuma chamada de rede operacional, publicação ou chamada paga.

Última publicação permanece **API/worker r9 e frontend v11**, documentada em [revisão humana publicada](SPRINT-04-META-REVISAO-HUMANA-20260914.md), com rollback r8/v10. Não foi novamente inspecionada nesta rodada. A admissão runtime da campanha ainda não está na r9; não conectar esta composição a uma campanha paga antes de preparar/verificar um pacote compatível.

Última fotografia remota, **03:55:02.920421 UTC**, não renovada nesta etapa: 359.814 microUSD contabilizados, 640.186 disponíveis no gate de 1.000.000; 31 reservas liquidadas, zero pendentes/desconhecidas/jobs ativos/canais/deliveries. Teto total autorizado R$ 10 preservado. Gabriel já é admin por autorização específica executada; João continua reviewer. Isso não constitui aceite comercial.

## Próximo trabalho e dependências

Falta ligar a composição a fontes reais autorizadas de prontidão, revisão e provas, fechar viabilidade/contexto/custo T2 e o pacote compatível, antes de iniciar a campanha financeira. Não preencher essas dependências com observações antigas ou identidades simuladas. Fontes comerciais, critérios e publicação financeira mantêm seus próprios gates.

A exigência de saída bruta nas provas ainda precisa ser reconciliada com a evidência efetivamente disponível e a regra do plano de preservá-la quando disponível; sua ausência não pode ser resolvida por reconstrução ou referência falsa. Os artefatos já preservam a resposta observada, sem afirmar que ela é o bruto original.

Continuam pendentes: acesso autenticado autorizado, QA publicada desktop/mobile e papéis, avaliação pessoal do João, campanha 30×2/nota humana, publicação financeira, M6 real e aceite comercial de Gabriel. A proposta de infraestrutura continua sem autorização; nenhuma contratação/migração ocorreu. Usuário pediu que Codex faça o login, mas a tentativa anterior encontrou a aba deslogada, sem senha/autofill; não foi obtida uma sessão neste turno e não foi enviado e-mail ou executado reset por inferência.
