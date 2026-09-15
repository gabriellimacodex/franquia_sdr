# Sprint 4 — recuperação conservadora após confirmação perdida

14/09/2026 UTC (noite de 13/09 em São Paulo). **R8 publicada na API e no worker às 00:27:09 UTC**, após 284/284 testes na imagem isolada. Saúde, flags e auditoria pós-deploy aprovadas; rollback r7 preservado. Meta ativa, sprint não concluído. O turno de status confirmou que o processo de regressão havia terminado; esta continuação preservou a evidência e executou a publicação controlada.

## Falha, correção e limites

Reprodução RED: após uma reserva confirmada e erro do POST/ACK, o lease expirado permitia `Store.claim` devolver o mesmo job com `attempts=2`. O catch do worker também devolvia erros indiscriminadamente a `pending`. Como a reserva anterior era reconhecida só por gate+job+attempt, outro attempt/gate podia autorizar novo POST.

- Claim no laboratório exclui jobs com **qualquer** reserva para tenant+brand+job, sem filtrar gate, attempt ou liquidação. Mantém o advisory lock anterior à consulta e os locks da fila. Não altera o prazo.
- O handler tipado de falha observa essa mesma evidência sob lock: conserva `working` e registra `ORCHESTRATOR_ACK_UNKNOWN` se há reserva; sem reserva, preserva o backoff de cinco segundos. Nunca reabre outro attempt ou estado terminal.
- Coordenador e helper de orçamento bloqueiam reservas repetidas por job, não só pela chave do evento.
- A resposta original continua elegível até o deadline, sujeita a versão, revisão, epoch, controles e guards existentes. Se aceita, liquida uma única reserva uma única vez; timeout pausa e mantém custo desconhecido integral.
- Falhas comprovadamente anteriores à reserva podem recuperar. Se o COMMIT da reserva ocorreu mas o processo morreu antes do POST, não há retry automático: é indistinguível de envio ocorrido. Não prometer exactly-once dentro do n8n/provedor ou proteção contra execução manual externa.
- WhatsApp conserva recuperação/backoff existentes; canais e envios continuam desligados. Nenhum schema, modelo, preço, limite ou autorização mudou.

## Provas locais

Quatro ciclos RED→GREEN: reclaim após reserva; handler ainda inexistente; segundo POST com outro gate/attempt; helper aceitando segunda reserva. Seis regressões adicionais já verdes, sem alegar novos REDs. `tests/lab-dispatch-recovery.test.ts`: dez testes, incluindo callback antes/depois de ACK perdido, retry sem reserva, controles/revisão, timeout dos estados working/running/pending legado, WhatsApp e erros sanitizados.

O teste antigo de múltiplas reservas foi convertido em **fixture histórica explícita**: a criação de um segundo attempt deixou de ser comportamento permitido, mas a assertiva de manter todas as reservas ambíguas integrais permaneceu. Não foi removida nem relaxada a proteção do ledger.

Subset principal **25/25**, 10.827,690291 ms; revisão independente recuperação/orçamento **21/21**, 7.706,578417 ms.

Carson acrescentou três provas em `evaluations/completion-postgres.test.ts`: reserva COMMIT vence reclaim; reserva ROLLBACK libera reclaim; reclaim vence preparação antiga. Dois clientes runtime sem SUPERUSER/BYPASSRLS, FORCE RLS, contenção realmente observada em `pg_locks`, PostgreSQL 17.10. Arquivo completo **7/7**, 2.055,398542 ms, TypeScript aprovado. Novos testes já passaram sobre o claim corrigido. Somente ranking pgvector foi substituído pela fixture lexical vazia; locks, header, contexto, ledger e COMMIT/ROLLBACK reais. Container exclusivo `sapore-s4-retry-proof-20260914` encerrado e removido, sem tocar outros containers.

Regressão completa da árvore compartilhada: **375/375 + TypeScript**, 58.455,272417 ms, zero falhas/skips/cancelamentos. [TAP integral](SPRINT-04-META-RECUPERACAO-REGRESSAO-20260914.tap), SHA `7a23781c7290bd9e893d4287be251244cf613ab01ce27c7ad716a7eaebec2fec`.

Nova rodada determinística necessária pela alteração de runtime: [JSON](SPRINT-04-META-DETERMINISTICA-20260914T000952364Z.json), **60/60**, zero críticas, 00:09:52.364→00:10:16.331 UTC. SHA `7f56ed0544475a07b8eff9c838e84b8aba29c7f6e7d966c656ca6abd1ae50d2b`; manifesto de **66 arquivos** `a8a7e3a2b8abbff1b66acd3d2c3a667e754303f3ebf9bd5e7091132d4e6d6cb4`, todos novamente conferidos após execução. Mesmo snapshot `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959`, modelo fixado sem chamá-lo. Rodadas anteriores preservadas. A matriz não substitui avaliação conversacional, aceite humano, registro administrativo ou M6.

## Prontidão somente leitura

Hypatia implementou `evaluations/sprint4-readiness.spec.ts`, `evaluations/sprint4-readiness.ts` e seu teste: **10/10**, nove RED→GREEN e uma regressão de colisões. Revisados pelo principal. Uma consulta em transação READ ONLY observa escopo, membership administrativa real, hash/modelo/snapshot, sessão própria, ledger integral, contagem de mensagens de 24h e jobs ativos. Fixtures PGlite antes/depois idênticas; erros não devolvem dados privados.

Identidade do chamador deve vir de autenticação independente; o adapter não autentica JWT. Limite de um milhão é explicitamente política, não configuração remota comprovada. Bound exato, novo deadline, runtime/n8n/publicação, revisão restante da campanha e aceites permanecem pendentes. Não prepara, reserva, envia ou concede autorização. Não está conectado ao runner pago nem incluído na imagem candidata.

## Recorte de publicação e bloqueador evitado

Uma reprodução independente contra a **Engine r7 real** mostrou que publicar apenas Store/helper/worker deixaria uma falha de integridade: attempt antigo retomado depois da conclusão sobrescreve contexto terminal (timing attempt2→1, histórico1→2), apesar de não iniciar outro POST. Esse recorte estreito não foi publicado.

O candidato inclui também o preparo transacional/fencing e a leitura de conclusão previamente testados: 11 arquivos runtime, pares CompletionSnapshot, LaboratoryDispatch e DispatchFailure; Engine, knowledge, lab-budget, Store e worker. Modelos/prompts/guards, financeiro, n8n/protocolo, rotas, schema, config e Compose são idênticos à r7. Não é uma publicação de financeiro v2 nem afirmação de resolver latência.

Pacote isolado `/tmp/sapore-s4-ack.odO2Q1/sapore-sdr`: **124 arquivos, 18 diferenças** contra os 112 arquivos verificados da base r7; 11 runtime e sete testes. Não é a árvore local inteira. Arquivo `backend-ack-recovery.tar.gz`, SHA `b6376455e3c85ede1f91b237e6eb92dbdb7db784cb8e4104b250e890c60963f7`; manifesto `backend-ack-recovery-manifest.json`, SHA `4f8b8446a33a41d432e986dd4c2e64d56edadf3f13b1aeebd358770c92c17b49`. Tar contém apenas os caminhos do manifesto, sem env/Git/node_modules. O link local de dependências foi adicionado depois do tar, fora do artefato.

O primeiro pacote foi **reprovado: 277/284**, sete falhas, 43.217,83 ms. A revisão encontrou quatro arquivos de teste ainda r7 (`completion-round-trip`, `engine-timings`, `latency-engine`, `preflight-round-trip`), com contagens, formato de lock e nomes de telemetria anteriores ao coordenador. Os quatro diffs já existentes no workspace foram lidos pelo principal; assertivas de persistência, ledger, replay e isolamento não foram relaxadas. Tar, manifesto, script e TAP inicial foram preservados no diretório acima, sem publicação.

Pacote corrigido em **novo diretório** `/tmp/sapore-s4-ack-final.3Cx3Sr/sapore-sdr`: 124 arquivos, **22 diferenças** (11 runtime + 11 testes). Tar SHA `07fe412087aaf5c7bafcf5de2225773067053ea8bd24dcef7896899d5c869468`; manifesto SHA `6d54c0e96d76a4b9ec145f43b726253924d84d1f4700233e9b652cb3012cddb9`. Runtime idêntico ao primeiro freeze; só os quatro testes faltantes foram incorporados.

Pacote final aprovado: **284/284 + TypeScript**, 46.092,116167 ms, sem falhas/skips/cancelamentos. [TAP final](SPRINT-04-META-RECUPERACAO-PACOTE-FINAL-20260914.tap), SHA `f797dc03b6b789be87d5a7969f96a372cfb0a8bf791f496f1c2454a6641dead7`. [TAP reprovado anterior](SPRINT-04-META-RECUPERACAO-PACOTE-REPROVADO-20260914.tap), SHA `9d341c25b0734c19a2a3f541a73c7aa3c99cce07b275ff9ce50135a9c1ed72b8`. Revisão independente final confirmou os124arquivos,22diferenças,imports completos,delta dos quatro testes e igualdade com o freeze.

Release candidata criada em `/opt/sapore-sdr/releases/20260914T001500Z/sapore-sdr`. Tar/manifesto transferidos e hashes novamente conferidos. Extração terminou com exit0 e avisos de atributos macOS ignorados; a verificação posterior confirmou **124 arquivos da release e62 da imagem**, todos com hashes exatos.

Imagem `sapore-sdr:sprint4-ack-recovery-20260914-r8`, ID `sha256:d41eb3acb91ce49810d93787bb9716d1381f4d08f9c418e54e2a4020f167a46a`. Build TypeScript aprovado. Base/lockfile/cache de dependências preservados. API/worker r7 não foram parados ou recriados.

### Regressão da imagem — concluída e preservada

Regressão da imagem iniciada às **00:16:13.062081553UTC** no container `sapore-s4-r8-regression-20260914`, ID `cd9988090d58ed7aa154e64c8748e62af489e5c14ca8515713ae0a37308d06c7`. Última conferência às00:16:35UTC: **running=true**, rede `none`, rootfs somente leitura, até teste17 aprovado; resultado final ainda desconhecido. Limites1CPU/1GiB/128processos,capabilities removidas,tmpfs512MiB,sem credenciais/env/banco real; somente testes/evaluations/Compose da release montados RO. Comando Node real: `node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts`.

O mesmo processo terminou às **00:23:48.021082627 UTC**, `exited`, `running=false`, exit 0, OOM false, erro vazio: **284/284**, zero falhas/skips/cancelamentos, 454.736,50571 ms. Não houve reinício da bateria. [TAP integral da imagem](SPRINT-04-META-RECUPERACAO-IMAGEM-20260914.tap), SHA `9e965cd4213b04e76e5a95ac7278b5245d5fa2bdcd11cac83c92fa055a353515`; [metadados observados](SPRINT-04-META-RECUPERACAO-IMAGEM-20260914.json). Stderr vazio também preservado. Após conferir os artefatos, somente o container sintético encerrado foi removido; imagem, release, rollback e dados reais foram mantidos.

Rollback disponível, não executado: release `/opt/sapore-sdr/releases/20260911T231330Z/sapore-sdr`, imagem r7 `sha256:e7344368187fd0b13e9727a38ce4cf6267850fc4c98ebd45551b5ef9a8081229`, mesmos dois Compose/ambiente/CA, exclusivamente `api worker`, sem apagar dados. Antes de qualquer retorno, auditar trabalhos em voo e parar o worker substituído, sem misturar preparações de versões distintas.

## Publicação controlada r8

- Baseline READ ONLY **00:25:13.447218 UTC**: 31 reservas liquidadas, zero pendentes, 359.814 microUSD contabilizados / 640.186 disponíveis, zero jobs ativos/canais habilitados/deliveries. Snapshot/modelo e memberships inalterados. Imagens r7/r8 e hashes do tar/manifesto novamente conferidos.
- Seis flags reais da API e do worker r7 conferidas antes da parada. Worker r7 encerrado às **00:26:06.467708152 UTC**. Auditoria pós-parada **00:26:40.597925 UTC**, `transaction_read_only=on`: zero jobs ativos, reservas pendentes ou desconhecidas em qualquer gate. API antiga permaneceu ativa até a substituição.
- Compose validado e executado com `up -d --no-build --no-deps api worker`, somente na release candidata e projeto `sapore-sdr`, usando os caminhos existentes de ambiente/CA e ambos os arquivos Compose. Exit 0. Não houve build novo nem publicação da árvore compartilhada posterior.
- API: container `2d608ee9c03e7f55b9ba1aa1fafdc352c9a3187d332cd9e059ed60d931b3bc91`, iniciada às **00:27:09.836827589 UTC**.
- Worker: container `8b0e573726be121a4e4d58d982b05a5fa29a6c5d0f8a3ac57679aaec0a0f7a86`, iniciado às **00:27:09.838582099 UTC**.
- Ambos executam a imagem r8 `sha256:d41eb3acb91ce49810d93787bb9716d1381f4d08f9c418e54e2a4020f167a46a`, running e zero reinícios. API healthy. GET público `/health` 200/outbound false e `/ready` 200; GET de sessões e POST de avaliação sem autenticação retornaram 401 `AUTHENTICATION_REQUIRED`, sem criar sessão. Logs do worker desde a ativação sem erros observados.
- Flags reais nos dois serviços: `EXECUTION_MODE=laboratory`; `CHANNEL_ENABLED`, `NATIVE_CONTROL_VERIFIED`, `RETENTION_ENABLED` false; gate `sprint3-continuous-20260910`, cap `1000000`. Nenhuma credencial exposta ou alterada.
- Pós-deploy **00:27:41.083043 UTC**, READ ONLY: mesmo ledger/saldo, 31 settled, zero pending/unknown em qualquer gate; jobs completed 40 / handoff 9 / ativos 0; canais habilitados 0, deliveries 0. Admin 0 / tester 1 / reviewer 1; drafts/validation_runs/publication_events/v2 persistido ou ativo 0.
- Snapshot ativo `sapore-v1-a1a330f07cd0`, hash `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`, modelo `gpt-5.4-2026-03-05`, contrato legado. Frontend v10/n8n sem mudança nesta publicação. Nenhuma chamada paga nova.

## Baseline remota e próximo passo

Auditoria READ ONLY **00:09:15.734255 UTC**: 31 reservas/31 settled/zero pending; **359.814 microUSD contabilizados / 640.186 disponíveis** na cota original; jobs completed40/handoff9, zero canais habilitados/deliveries. Nenhuma chamada paga nova pela equipe da meta. API/worker r7 running, API healthy, mesmos IDs/horários de início; seis flags da API e do worker novamente conferidas às00:12/00:14UTC. Mudanças remotas limitadas ao novo diretório, imagem candidata e container de teste isolado; dados, usuários e serviços ativos não alterados.

O parágrafo anterior preserva a baseline histórica das 00:09; a referência atual é a auditoria pós-deploy das 00:27:41 acima. Verificação da imagem e publicação de integridade/recuperação estão concluídas. Próximo passo: concluir o vínculo entre admissão conservadora da campanha e medição/reserva real, depois integrar o runner/custo completo e as avaliações planejadas. Latência M6, financeiro/publicação humana, novo login/QA/papéis, validação pessoal de João e aceite comercial de Gabriel **não cumpridos**. A publicação não é aceite de memória/financeiro com modelo, prova de latência nem ativação de v2.
