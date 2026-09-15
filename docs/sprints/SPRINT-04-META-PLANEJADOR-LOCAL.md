# Sprint 4 — planejador e preparação de pedidos, somente locais

Checkpoint de 11/09/2026, medição às **23:03:27.303 UTC**. Não é campanha executada, qualidade medida, autorização de despesa ou publicação.

## Planejador puro

`evaluations/sprint4-campaign.spec.ts` fixa os 30 casos e 33 inputs literais do [plano](SPRINT-04-META-PLANO-AVALIACAO.md). `sprint4-campaign.ts` gera IDs estáveis por campanha/fase/repetição/caso/turno, 60 execuções conversacionais com 66 turnos e três novas sessões M6 com seis turnos adicionais por padrão. O adiamento explícito de M6 mantém a pendência, não a dispensa.

Cada sessão é nova, o segundo turno depende do primeiro terminal auditado, e todos os resultados/notas/IDs remotos permanecem nulos ou pending. Target/hash/modelo são consistentes, mas não verificados remotamente. `validate` rejeita matriz, ordem, IDs, vínculos, contagens, pins ou resultados adulterados. Sete ciclos RED→GREEN, sete testes e revisão independente aprovados.

Checks financeiros e diários só comparam fotografias fornecidas: gate `sprint3-continuous-20260910`, teto técnico 1.000.000 microUSD, 100 mensagens por mesmo usuário/24h móveis. Mesmo uma comparação favorável deixa `readyToExecute=false`, `requiresLiveRecheck=true`, pins não verificados e gates pendentes. Não há cálculo fictício de custo total ou mínimo adicional; ambos ficam null. Controle gratuito também exige capacidade adicional. Não há rede, relógio, ambiente ou I/O nesse planejador.

## Medição offline dos primeiros turnos

`evaluations/sprint4-payload-bounds.ts` usa contrato validado separado e PGlite efêmero com migrations locais. Usa o fluxo real de draft, sessão privada, mensagem, claim e `Engine.prepare`, **nunca dispatch/complete/reserve/recordValidation/publish**. O transporte injetado rejeita qualquer chamada; não aceita DB URL, credencial ou adaptador remoto. A membership admin existe apenas nessa fixture isolada e não representa autorização real de Gabriel.

Cada T1 começa com memória vazia e uma única mensagem canônica, usando fonte/schema/modelo do snapshot fornecido. Depois de medir, o job da fixture é marcado `stale/OFFLINE_PREPARATION_ONLY` para não ser retomado após o lease de 15 s em uma máquina lenta. Não recebe resultado de modelo ou liquidação simulados. Todos os dados desaparecem quando o PGlite em memória é fechado.

Dois RED→GREEN: implementação da preparação e ausência de jobs preparados ainda reclamáveis; teste de entradas inválidas adicional. **2/2** e TypeScript aprovados. Revisão independente identificou/reproduziu a borda do lease, corrigida e revalidada. A suíte compartilhada final passou **249/249**, 35,521080167 s.

## Evidência e interpretação dos números

Artefato: [30 medições T1](SPRINT-04-META-T1-BOUNDS-20260911.json), SHA-256 `6fe2d59084037b48e95b0930dbd6975698dedffd5922a94a96025646a794327b`.

- Base local: `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`, igual ao hash ativo da última auditoria remota, sem nova leitura remota nesta continuação.
- Candidato financeiro local: `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959`. A versão UUID no artefato é **local**, não uma versão salva/publicada no Supabase.
- Schema de saída: `aafec0a7b9eee2fffb8b5161c20259695def1e2aa607288556d93f4765017e2e`.
- 30 preparações T1; zero modelo/reserva/publicação/relatório de validação, zero jobs ativos restantes na fixture.
- `inputTokenBound` de **16.067 a 16.196**: bytes UTF-8 do payload efetivo da fixture + 4.096, **não tokens efetivamente consumidos**.
- Reserva hipotética de **58.168 a 58.490 microUSD** por T1. C01: 58.490; C02: 58.383; C03: 58.465.
- Soma dos 30 T1: **1.748.758 microUSD**; duas repetições desses T1 corresponderiam ao envelope de 3.497.516. **Não é custo realizado nem mínimo de dinheiro adicional**. A liquidação serial pode liberar parte de cada reserva.

`payloadSha256` identifica a instância local medida, incluindo UUIDs/timestamps. Não é estável entre execuções nem prova de payload remoto. Não reconstruir conteúdo bruto remoto com esses dados. Na chamada real, medir e reservar novamente o payload exato; os dados acima não substituem o ledger ou os checks por chamada.

Os seis T2 da campanha (C01–C03 em R1/R2) dependem de respostas/extrações reais de T1 e **continuam desconhecidos**; os turnos M6 também requerem versão publicada e suas próprias evidências. A hipótese anterior de 67.348 permanece ilustrativa para contexto maior, não teto provado para T2. O dry-run parcial não demonstra que toda a campanha caiba no saldo.

## Próxima etapa

Preparar pacote compatível do runtime e validar a rota candidata publicada; obter autorização específica da membership administrativa; completar o controlador da execução com auditoria terminal, coleta privada e rechecagem do saldo/capacidade por turno. Planejar lotes e dependências sem inferir resultados futuros ou diminuir o gate 30×2. Notas humanas, aceite comercial, QA publicada e M6 permanecem obrigatórios.

Não houve mudança de schema, papel, credencial, serviço remoto, saldo ou modelo nesta continuação.
