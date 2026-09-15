# Sprint 4 — execução local da matriz determinística

## Escopo e vínculo da evidência

Execução local dos 30 cenários D01–D30 previamente definidos em [plano de avaliação](SPRINT-04-META-PLANO-AVALIACAO.md), com duas repetições independentes. O resultado só vale para os arquivos identificados no manifesto do artefato, não automaticamente para a imagem r7 publicada.

- Candidato base: `createFinancialDraftSnapshot(initialSnapshot({tenantId:'cognita-homologacao',brandId:'sapore'}))`.
- SHA-256 do snapshot: `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959`.
- Modelo fixado na configuração: `gpt-5.4-2026-03-05`. **Não foi chamado nesta suíte.**
- Fixtures fictícias; guard, memória, recuperação, sessões, conclusão e ledger usam código real local. Bancos PGlite novos são fechados após cada fixture. D10 inclui também a versão legada identificada para comprovar compatibilidade, e D11–D14 adulteram cópias de fontes para comprovar rejeição.
- Cada linha guarda entrada, objetivo, observação real e duração monotônica; erros viram reprovações, não aprovação. Não há nota humana, registro de validação no Supabase ou publicação do snapshot.

## Resultado final da matriz

[Artefato final de 23:54:17.520–23:54:26.407 UTC](SPRINT-04-META-DETERMINISTICA-20260913T235417520Z.json): **30 cenários × 2, 60/60 aprovados, zero violações críticas nas assertivas da matriz**. Duração total de 8,887 segundos; não é uma medida de latência do chat. Zero chamadas reais de modelo, zero custo pago, nenhuma operação remota.

- SHA-256 do JSON: `86e535d7315deb57d556ae545b24c620b24a89d161e954f12b6e106fbe55a488` (642.317 bytes).
- Manifesto dos 62 arquivos: `354d4b78540887f8edf713aca4273278dd356d77a2990d5cfd22a62a6b9cb419`, idêntico antes/depois da execução e conferido novamente após a gravação.
- Runtime: Node `v24.13.1`; o JSON registra plataforma/arquitetura, todos os hashes, a entrada e observação completa de cada repetição.
- D22/stop: guard financeiro aprovado antes/depois do reparo, sem propostas/relações novas. D28: sessão real interrompida; no trecho de guard → reparador, stop preservado sem propostas/perguntas. Ambos os casos foram conferidos nas duas repetições do JSON.

Isso conclui a **evidência determinística local deste candidato**, não a homologação financeira completa nem o gate de publicação. A imagem a publicar deverá corresponder ao código avaliado ou receber sua própria revalidação; os adaptadores/campanha conversacional, registro administrativo e aceites continuam pendentes.

Regressão final, após o fortalecimento das fixtures: **355/355 aprovados**, zero falhas/skips/cancelamentos, 50.140,229917 ms; `npm run build` (TypeScript) exit 0. [TAP final integral](SPRINT-04-META-DETERMINISTICA-REGRESSAO-FINAL-20260913.tap), SHA-256 `a6c086be1756c63ef61035e41c6a7a2a6b3680cc76dff1728e481ca3bff4beb8`. Comando: `node --import tsx --test --test-concurrency=4 --test-reporter=tap --test-reporter-destination=docs/sprints/SPRINT-04-META-DETERMINISTICA-REGRESSAO-FINAL-20260913.tap tests/*.test.ts`.

Revisão independente concluída por Carson/Hypatia nos módulos/controles/coletor; responsável principal conferiu os catálogos e a integração. Carson auditou o JSON final, seus 62 hashes atuais, unicidade das 60 combinações, presença das observações e os controles corrigidos de D22/D28. Nenhum bloqueador material do artefato local permaneceu. A integração não alterou código de produto em `src`, frontend, dependências ou configurações remotas.

## Histórico preservado e revisão

Primeira execução: [JSON de 23:50:05.941–23:50:15.203 UTC](SPRINT-04-META-DETERMINISTICA-20260913T235005941Z.json), **60/60**, zero falhas nas assertivas então existentes. SHA-256 `f96c024b4890b1c1421d5b10edc9a573ad8f453799fb8dcf949e16f6a88001ac`, manifesto `aaafe78f895866a918d0513408a9f584a203ed72bcfba1ee446c87ec83fd561c`, 62 entradas. Arquivo de 644.907 bytes preservado, não sobrescrito.

A revisão encontrou uma lacuna de validade em D28, também aplicável à variante stop de D22: o reparador recebia propostas junto de stop, DTO que o guard rejeitaria antes. Era teste de helper, não uma trajetória válida pós-guard. O primeiro resultado é **histórico, não o resultado final**. As fixtures foram fortalecidas para passar pelo guard financeiro real sem coleta, mantendo a memória conflitante já construída. Os critérios originais não foram reduzidos. Nenhum `src` foi alterado.

Foram observados 30 ciclos RED por caso ainda ausente → implementação → GREEN, mais quatro do coletor e os testes adicionais das fixtures de stop. Durante o ajuste de D28, uma asserção intermediária de igualdade integral foi reprovada porque o reparador corretamente substituiu a promessa por aviso; a fixture voltou a exigir aviso e preservação dos demais campos. Essa falha de implementação da avaliação não foi ocultada nem corrigida mudando o produto.

Revisões independentes identificaram e fecharam no coletor: observações ausentes aceitas por `z.unknown()`, sobrescrita de metadados por spread, caminhos não canônicos do manifesto e imports de casos anteriores ao registro dos fontes/bloqueio de `fetch`.

Primeira regressão compartilhada: [TAP integral](SPRINT-04-META-DETERMINISTICA-REGRESSAO-20260913.tap), **353/353**, 50.725,619041 ms; antes do fortalecimento final de D22/D28. Não equivale ao pacote de 238 testes da imagem r7.

## Limites obrigatórios

- O campo `networkAttempts` do JSON conta tentativas pelo `fetch` bloqueado; não é um firewall nem contador universal de sockets. Os caminhos inspecionados usam PGlite e transportes locais injetados. Não houve acesso remoto ou chamadas pagas nesta execução.
- D10, D29 e D30 usam dispatch/ACK/callback e uso de tokens **construídos**. Reservas e custos nesses bancos são fixtures; não entram no ledger real nem demonstram o custo da campanha conversacional.
- D22–D26 medem o reparador e memória em camadas explícitas; não simulam compreensão universal do modelo. D26 registra a eventual omissão integral de uma pergunta posterior para preservar a resposta independente inteira.
- Tempos locais incluem preparo do banco quando aplicável. Não são latência visível no navegador, velocidade do modelo, SLA ou aceite M6.
- Nenhum papel administrativo remoto foi fabricado, usuário promovido, fonte comercial alterada ou gate contornado. Setup de versão/índice local não é publicação.
- A proteção contra repetição de callbacks não cobre retries do worker após ACK perdido. Ver [limites do preflight](SPRINT-04-META-PREFLIGHT-LIMITES-20260913.md).

## Reprodução

No diretório `sapore-sdr`, executar `node --import tsx scripts/sprint4-deterministic.ts`. A CLI exige exatamente D01–D30, faz R1 e R2, verifica o manifesto antes/depois, salva JSON exclusivo com timestamp e retorna código 1 se houver falhas. Não sobrescreve artefatos anteriores, não carrega `.env` e não registra validação/publicação. A implementação e os testes do catálogo ficam em `evaluations/sprint4-deterministic*.ts` e `tests/sprint4-deterministic*.test.ts`.

## O que continua pendente

Campanha conversacional real 30×2 e suas notas, fluxo administrativo, registro efetivo das validações/publicação financeira, seis turnos M6, QA autenticada desktop/mobile/papéis e aceites de João/Gabriel. A meta e o sprint continuam abertos mesmo com a conclusão da parcela determinística local.
