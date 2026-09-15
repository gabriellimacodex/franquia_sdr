# Sprint 4 — M3: diagnóstico estrutural de latência

11/09/2026. Diagnóstico somente leitura de código, relatórios e contagens locais, autorizado pela [meta de fechamento](META-FECHAMENTO-SPRINT-04.md). Este documento não implementa, publica nem autoriza infraestrutura adicional. Não houve chamada paga, navegador ou acesso remoto pelo autor desta revisão. As medições remotas abaixo foram fornecidas pelo responsável principal da meta.

## Conclusão

O gargalo controlável demonstrado é a **orquestração serial sobre uma conexão de aproximadamente 137 ms por viagem PostgreSQL**, não o cálculo do guard/memória. Um turno comum executa **61 viagens** até uma leitura final, ou **63 quando persiste fatos e relações**, antes de contar polls intermediários e ciclos ociosos do worker. Esses leitores e escritores compartilham um advisory lock exclusivo por tenant/marca. A chamada n8n/modelo é outra parcela importante: 4,968–5,457 s nos dois últimos turnos.

As contagens e o RTT sustentam uma hipótese estrutural; não decompõem exatamente os 16,784–19,547 s observados na tela. Algumas etapas se sobrepõem, há espera por locks e existem intervalos ainda não medidos. **Não há evidência de que uma nova redução isolada de uma a quatro queries entregue mediana ≤ 5 s e todos os seis turnos ≤ 8 s.** Os ganhos anteriores de queries não demonstraram melhora E2E.

Recomendação: modelar o caminho completo com atraso controlado antes de mais patches. Comparar duas mudanças estruturais separadamente: reduzir a distância efetiva aplicação–banco, preservando a lógica, e substituir a descoberta periódica da conclusão por aviso pós-commit. A primeira tem o maior potencial sem reescrever guard, memória ou ledger; depende de opção operacional existente ou autorização específica. A segunda reduz espera e contenção, mas não resolve sozinha o custo serial de banco/modelo. A meta de 5 s pode continuar inviável para parte dos turnos com o mesmo modelo; não flexibilizar o critério nem afirmar viabilidade sem a bateria final.

## Evidência de rede e de produto

O responsável principal mediu no container API r5 em **22:27:14.149 UTC**, descartando uma única preparação do pool e intercalando cinco amostras, sem dados de negócio ou chamadas pagas:

| Operação | Amostras em ms | Mediana em ms |
| --- | --- | ---: |
| `SELECT 1` | 137,036 / 136,507 / 137,008 / 136,984 / 136,467 | **136,984** |
| `BEGIN; SELECT 1; COMMIT`, três chamadas | 411,069 / 409,947 / 409,758 / 408,806 / 409,884 | **409,884** |
| `scoped(SELECT 1)`, quatro chamadas | 599,801 / 545,688 / 546,531 / 934,006 / 547,572 | **547,572** |

A proporção entre as medianas é compatível com custo por viagem. O valor de 934,006 ms não prova contenção, pool ou causa específica. A região do Supabase foi confirmada pelo responsável como **`us-east-2`**; a localização da VPS não foi comprovada nesta revisão e não deve ser inferida pelo IP.

No [gate S4.10](SPRINT-04-ROUND-TRIPS-GATE-20260911.md), perfil/correção:

| Intervalo | Perfil | Correção |
| --- | ---: | ---: |
| Envio → resposta útil visível, E2E | 19.547 ms | 16.784 ms |
| `n8nReported.modelRoundTripMs` | 5.457 ms | 4.968 ms |
| Preflight completo | 569 ms | 556 ms |
| Preparo completo | 1.052 ms | 987 ms |
| Reserva de orçamento | 986 ms | 976 ms |
| ACK do webhook | 484 ms | 392 ms |
| Entrada de `complete` → início do guard | 1.964 ms | 1.122 ms |
| Guard e memória em JavaScript | 8 ms | 2 ms |
| Persistência até antes do evento | 725 ms | 714 ms |

O par n8n tem mediana aritmética de 5.212,5 ms, apenas descrição dessas duas amostras, não distribuição futura. Esse intervalo inclui HTTP e overhead entre nodes; usa relógio de parede, não mede inferência pura. O backend usa relógio monotônico, mas suas métricas não incluem todo o callback/commit. O `completed_at=now()` é início da transação, não confirmação de commit. Não subtrair timestamps de navegador, banco e n8n para inventar uma decomposição exata. Não inferir p95, SLA ou causalidade do aumento E2E frente à r4.

## Caminho real e contagem reproduzida

Foi executado um script efêmero via entrada padrão, usando os imports reais de `testDatabase`, `LabSessions`, `Store` e `Engine`, PGlite em memória e `transport` simulado. Nenhum arquivo de código/teste foi criado ou alterado. O wrapper contou cada `query` e acrescentou `BEGIN`/`COMMIT` conforme `Database.transaction`; **não simulou duração real nem concorrência de rede**.

| Etapa comum | Viagens PostgreSQL | Observação |
| --- | ---: | --- |
| Envio autenticado de texto contextual | **13** | 1 membership + 12 dentro da operação, incluindo BEGIN/lock/COMMIT; mais 1 HTTP Auth |
| `channels` + `claim` | **6** | 1 leitura global + transação com expiração e claim; zero expirados nesta contagem |
| Preflight | **4** | BEGIN, scope/lock, SELECT, COMMIT |
| Preparo | **7** | BEGIN, scope/lock, leitura agrupada, snapshot das fontes, ranking, contexto, COMMIT |
| Reserva | **7** | BEGIN, scope/lock, job, duplicação, soma, INSERT, COMMIT |
| Gravação do ACK | **4** | BEGIN, scope/lock, UPDATE condicionado à tentativa, COMMIT |
| Conclusão com usage válida, dois balões e memória vazia | **15** | Inclui canal, locks ordenados, validação, mensagem/evento, liquidação e COMMIT |
| Acréscimo quando há fatos e relações | **+2** | Uma escrita por coleção em `persistLeadMemory`, mesmo quando dados existentes não mudam |
| Um detalhe final autenticado | **5** | 1 membership + BEGIN, scope/lock, snapshot privado filtrado, COMMIT; mais 1 HTTP Auth |
| **Total com um detalhe final, sem/com ambas as coleções** | **61 / 63** | Não inclui polls ou ciclos ociosos adicionais |

O script confirmou diretamente send=12 sem autenticação, channels+claim=6, dispatch=22 em quatro transações, complete=15, detail=4 sem autenticação e ciclo ocioso=6. Os dois SELECTs de membership e as duas escritas opcionais de coleções são contados a partir dos caminhos reais correspondentes. A suíte `completion-round-trip.test.ts` confirma complete=13 queries + BEGIN/COMMIT para o caso sem memória, e `engine-timings.test.ts` confirma dispatch=14 queries + oito viagens de BEGIN/COMMIT.

Multiplicar 61/63 por 136,984 ms resulta em **8,36/8,63 s de contabilidade de transporte** sob hipótese de RTT uniforme. Isso **não é tempo E2E previsto**, economia garantida nem parcela que possa ser somada integralmente ao n8n: o ACK e polls podem ocorrer enquanto o modelo trabalha; parte dessa contabilidade se sobrepõe. Cada fase internamente, entretanto, aguarda suas próprias queries serialmente.

### Envio e autenticação

- `PilotClient.request` usa o token local válido, renovando-o apenas próximo do vencimento. As requisições de negócio saem diretamente do navegador para a API; o frontend Sites não é um proxy intermediário de cada mensagem.
- Em cada rota `/v1/...`, `authenticateLab` faz **HTTP `/auth/v1/user` → SELECT membership ativa → operação autorizada**, nessa ordem. A duração desse HTTP ainda não está isolada nas métricas existentes. Cache de identidade/membership não é uma correção segura por padrão: pode enfraquecer revogação e troca de papel.
- Login/abertura inicial incluem configuração, `/v1/me` e lista; esses carregamentos não devem ser contados novamente em cada turno contextual. Criar sessão custa 10 viagens sem auth, 11 com membership. Abrir uma conversa existente inicia um detalhe.
- O POST de envio já devolve o detalhe privado na mesma transação. O frontend atual o aproveita e **não faz listGET/detailGET imediato extra** no caminho normal. O GET de fallback só existe para resposta de deployment antigo sem `detail`.
- Authorization/Content-Type em origem distinta podem implicar preflight CORS conforme o cache do navegador; nenhuma quantidade ou duração fixa de OPTIONS foi demonstrada nesta revisão.

### Worker, orçamento e concorrência

- O loop aguarda `channels`, `claim` e `dispatch` por canal, e depois dorme 1.000 ms. O ciclo ocioso ainda faz seis viagens, incluindo uma transação com o mesmo lock exclusivo da marca. `Briefings.dispatch` retorna imediatamente para laboratório; não é uma consulta nem chamada paga oculta.
- A duração total de um ciclo ocioso, sem contenção, seria aproximadamente 1,82 s com RTT uniforme de 136,984 ms. Isso é estimativa de código/rede, não medição de fila. Não atribuir toda espera de um job aos 1.000 ms do timer.
- `claim`, preflight, preparo, orçamento e ACK são transações distintas. A reserva é persistida e commitada **antes** do POST n8n. Nenhuma proposta pode antecipar o gasto para depois da chamada ou relaxar a exclusão entre tentativas.
- Enquanto aguarda o modelo, o worker pode voltar a expirar/reivindicar jobs. Polls, controles humanos, operações de outras sessões e conclusão disputam o advisory lock de tenant/marca. A existência dessa disputa é demonstrada pelo código; sua contribuição temporal exata não foi medida.

### n8n, conclusão e retorno à tela

- Workflow: webhook autenticado com ACK imediato → Code de preparo → **uma** requisição Responses → Code de parse → callback autenticado. Não há cadeia de múltiplos modelos neste fluxo; ambos HTTP nodes estão sem retry automático.
- A requisição preserva `gpt-5.4-2026-03-05`, `service_tier:'default'`, `max_output_tokens:1200`, schema e histórico. Não há streaming de texto aprovado no caminho atual; a primeira resposta útil depende de receber o JSON completo, validar e commitar.
- `complete` conserva lock de marca e locks de job → conversa → candidato, confere contexto/epoch/revisão/deadline, faz guard e reparação, grava memória/resultado/balões/evento e liquida o orçamento antes do COMMIT. O callback responde somente depois do sucesso transacional. A métrica atual termina antes de evento/liquidação/commit, portanto não mede todo esse custo.
- O frontend agenda o primeiro poll ativo 2,5 s após o detalhe retornado pelo POST; os seguintes compensam a duração da consulta, com piso de 500 ms. Cada poll custa novo HTTP Auth + cinco viagens DB. Oculto usa 30 s; idle/expirado/erro, 15 s. Não há sobreposição intencional na mesma cadeia, mas diferentes abas/usuários e worker podem concorrer.
- O texto só entra na UI após GET autorizado e commit concluído. Os controles de scroll podem mantê-lo fora do campo visual quando o usuário lê o histórico; isso deve ser separado de disponibilidade. Não usar saudação fixa ou texto ainda não aprovado para cumprir a meta contextual.

## Proposta estrutural mínima e critérios de decisão

### Próxima micro meta local: provar onde há alavancagem

Construir um único harness do caminho completo com servidor/cliente reais em processo, PGlite e n8n/Auth simulados, sem provedor. Usar atraso por viagem de **136,984 ms** e um relógio/agendador controlado para fila e polling; comparar com 10 ms sem alterar a lógica. Manter a mesma resposta completa do modelo em 3.000 e 5.500 ms, em casos pré-definidos, e variar Auth separadamente. Não apresentar essas durações simuladas como resultado remoto.

O RED deve reproduzir o excesso de espera da baseline, contabilizando send, claim, dispatch, callback após commit e GET/render. Registrar separadamente caminho crítico, número de chamadas, espera de aquisição do lock e sobreposições. Repetir com uma sessão e duas concorrentes/uma aba leitora. O objetivo desse experimento é escolher a intervenção que remove a maior parcela **sem** apenas transferir o tempo ou aumentar carga.

### Alternativas priorizadas

| Alternativa | Ganho plausível e limite | Segurança/dependência |
| --- | --- | --- |
| **1. Aproximar o runtime do mesmo banco `us-east-2`**, se houver opção operacional aprovada | Atua sobre dezenas de viagens e mantém a lógica atual. Reduzir RTT de 137 para 10 ms diminuiria a contabilidade de 63 viagens em ~8 s; não é economia E2E garantida e não elimina modelo/Auth/polling. | Confirmar opções e medir antes. Não afirmar localização da VPS. Contratar infraestrutura, mudar hospedagem/DB ou ampliar escopo requer decisão específica; não fazer por inferência da meta. |
| **2. Aviso de conclusão somente após commit, com GET final autorizado**, mantendo polling como recuperação limitada | Remove a espera periódica para descobrir o resultado e polls intermediários que disputam locks. Aviso pode conter só sinal de atualização, nunca conteúdo do modelo. Não acelera a conclusão em si. | Preservar auth/owner/revogação no GET final, abort/logout, reconexão, sem dependência durável do aviso. Não emitir em rollback, stale ou falha de liquidação. Não manter transação/lock aberto esperando evento. |
| **3. Se localização não puder mudar: comandos de banco por fase, em vez de muitas viagens** | Agrupar hidratação/locks e gravações de uma fase pode reduzir substancialmente viagens; diferentemente de apenas juntar dois SELECTs. Exige protótipo com contagem efetiva, sem meta numérica inventada antes do desenho. | Maior risco e superfície: preservar ordem de locks, contratos e rollback. Funções/objetos persistidos no banco são migração e exigem gate específico, mesmo criados por SQL avulso; sem SECURITY DEFINER ou grants novos por conveniência. |
| **4. Acordar worker após commit de envio**, mantendo claim/lease e recuperação | Reduz espera de descoberta da fila. Não substituir o claim por confiar no job recebido nem disparar modelo dentro da transação. Sozinha, economia limitada. | API e worker são processos distintos. LISTEN/NOTIFY ou canal interno exige verificar compatibilidade/conexões e manter recuperação de avisos perdidos/expiração. Não suprimir a manutenção de deadlines para reduzir consultas. |

Não recomendo iniciar pelas alternativas 2/4 isoladamente prometendo 5 s: mesmo retirando timers, persistem o custo transacional e o intervalo do modelo. Também não recomendo aumentar pool, reduzir indiscriminadamente polling, retirar advisory lock de leituras, validar JWT apenas por decode, armazenar autorização em cache ou chamar OpenAI diretamente para contornar n8n sem evidência. Nenhuma delas demonstrou resolver o gargalo preservando os contratos atuais.

Se o harness indicar que nem a combinação de menor RTT e descoberta imediata satisfaz 5/8 s com respostas equivalentes, registrar a limitação do piso de processamento e apresentar a decisão necessária. A autorização atual **não** permite trocar modelo, elevar saída, comprar infraestrutura ou relaxar o aceite por conta própria. Enquanto isso, memória, financeiro e demais testes independentes continuam.

## Verificação obrigatória antes de manter qualquer candidato

- Mesmo payload/versionamento/modelo/limite de saída; sem chamadas extras ou exposição antecipada de texto.
- Mesmo escopo tenant/marca/owner e revogação de sessão/membership; reviewer não é impersonado.
- Mesmo ordenamento de locks, snapshot e evidências; conflito, stop, handoff e revisão não se tornam aprovação automática.
- Reserva commitada antes de POST; um POST por tentativa; retries ambíguos permanecem conservadores; liquidação, mensagens e estado terminal atômicos.
- Replay, callback antes de ACK, mensagem nova/pausa durante geração, deadline e rollback de segunda bolha/liquidação.
- Aviso pós-commit não existe em rollback; perda/duplicação de aviso recuperável; abort/logout e múltiplas sessões não vazam dados nem duplicam envio.
- Comparação local inteira e concorrente, seguida de artefato isolado e avaliação publicada prevista na meta. Uma melhoria simulada não autoriza encerrar M3 nem escolher só amostras favoráveis.

## Ownership sugerido para a próxima implementação

Nenhum arquivo de código foi liberado nesta revisão. Divisão possível, a ser confirmada pelo responsável:

1. Um agente no **harness novo** de ponta a ponta e medição (`tests/lab-critical-path.test.ts`, nome proposto), sem tocar inicialmente no runtime.
2. Um único responsável para backend de execução/retorno (`server.ts`, `worker.ts`, `engine.ts`, `store.ts`, `lab-sessions.ts`, `database.ts`), apenas os arquivos efetivamente escolhidos pelo desenho. Não editar `engine.ts` concorrentemente às integrações financeiras.
3. Um agente de frontend para o transporte de atualização e lifecycle (`tester-workspace.tsx`, eventual `client.ts`, testes correspondentes), depois do contrato aprovado; sem mudança de layout/audiência ou login por conveniência.
4. Responsável principal por qualquer decisão de infraestrutura, gate de schema, empacotamento, publicação, saldo e bateria real. Não incluir financeiro v2 implicitamente no pacote de latência.

Referências de implementação: `src/database.ts` (`transaction`, `scoped`); `src/lab.ts` (`authenticateLab`); `src/lab-sessions.ts` (`send`, `detailTx`); `src/worker.ts` e `src/store.ts` (`claim`); `src/engine.ts`; `src/lab-budget.ts`; `src/knowledge.ts`; `integrations/n8n/artifacts.ts` e nodes; `borelli-expansao/app/components/pilot-lab/{client,pilot-lab,tester-workspace}.tsx/ts`. Skills de revisão/TDD, Supabase/Postgres e Sites orientaram a análise sem alterações operacionais.

## Continuação M3 — harness offline implementado

O responsável autorizou dois arquivos locais novos: `evaluations/latency-harness.ts` e `tests/latency-harness.test.ts`, além deste registro. Nenhum arquivo de produção, versão publicada, configuração, orçamento remoto ou canal foi alterado.

O harness executa `createServer`/rotas Fastify reais por `inject`, autenticação e membership reais do código com HTTP Auth simulado, `LabSessions.send`, `Store.channels/claim`, `Briefings.dispatch` (retorno imediato no laboratório), `Engine.dispatch`, callback autenticado de `Engine.complete` e detalhe autorizado. Usa PGlite em memória, fixture fictícia com uma proposta de cidade/uma relação, dois balões e usage simulada. O guard, a persistência e o ledger são reais dentro dessa base efêmera. O transporte rejeita destinos diferentes dos dois endpoints sintéticos; nunca delega a `fetch` real. Não há leitura de `.env` ou uso de credenciais do ambiente.

### Método e limites adicionais

- Relógio monotônico **real**, com espera artificial antes de cada operação PostgreSQL e antes da resposta simulada do modelo. Tempo de CPU local, event loop e agendamento dos timers estão incluídos; o atraso configurado não é uma rede emulada perfeitamente. Não é contador virtual somado para fabricar um resultado.
- Setup de banco, seed, sessão e primeira autenticação fica fora da janela. Cada caso começa o POST e a primeira varredura do worker juntos; a fase relativa do worker em produção varia.
- O loop espelha o caminho laboratorial normal, com espera de 1.000 ms ao fim de cada ciclo. Não implementa o processo real do worker nem simula seus caminhos de falha. O modelo devolve um callback assíncrono depois do ACK; sua resposta é fixa, não uma avaliação de modelo ou qualidade humana.
- Polling simula somente uma aba visível e um turno, com semente após o POST, intervalo de 2.500 ms e piso de 500 ms. Usa a mesma fórmula atual, mas **não importa/monta o componente frontend**. Sua equivalência precisa ser revista se o frontend mudar.
- HTTP Auth e ACK artificiais foram configurados em **0 ms** nos quatro casos, explicitamente uma lacuna, não medições reais. `authMs` e `ackMs` permitem variar essas parcelas em experimentos futuros. Token refresh, browser→API, CORS, HTTP n8n→API, processo/runners n8n, distribuição real do modelo e renderização não estão representados.
- PGlite serializa transações numa conexão única. Isso reproduz exclusão durante o trabalho de uma marca, mas desloca parte da espera para a entrada da transação em vez da aquisição do advisory lock e também pode bloquear leituras globais de modo diferente do pool de produção. Não usar a timeline para afirmar o tempo exato de lock/pool remoto.
- `callbackCommittedMs` é capturado **depois de a promessa de transação concluir**, não via `now()` do banco. `observedDetailMs` termina quando a resposta autorizada de detalhe, com os dois balões validados, foi recebida em processo. **Nenhuma dessas medidas é clique → balão visível.**
- Operações e spans podem se sobrepor. Contadores de query/viagem consideram operações iniciadas até a observação; transações contam commits concluídos até esse momento. Uma operação do worker já iniciada pode terminar durante a drenagem de encerramento; seu span pode ultrapassar a observação, mas isso não aumenta o tempo do endpoint. Não somar durações dos spans sobrepostos.

### Resultado: uma amostra por combinação, sem seleção posterior

Execução isolada: `node --import tsx evaluations/latency-harness.ts`. O comando produz JSON com opções, spans, contadores e invariantes, sem texto da conversa, IDs de usuário/job, prompts ou tokens. A matriz abaixo é **SIMULAÇÃO OFFLINE**, não benchmark do ambiente publicado, mediana representativa ou SLA.

| RTT artificial | Modelo artificial | Detalhe autorizado confirmado | Commit do callback | Queries / commits / viagens | Polls / Auth simulados |
| ---: | ---: | ---: | ---: | --- | --- |
| 136,984 ms | 3.000 ms | **12.177,197 ms** | 11.057,147 ms | 65 / 13 / 91 | 3 / 4 |
| 136,984 ms | 5.500 ms | **14.451,944 ms** | 13.896,536 ms | 74 / 15 / 105 | 4 / 5 |
| 10 ms | 3.000 ms | **5.280,181 ms** | 4.575,563 ms | 66 / 13 / 92 | 2 / 3 |
| 10 ms | 5.500 ms | **7.768,830 ms** | 7.097,958 ms | 77 / 16 / 109 | 3 / 4 |

Todos os quatro casos: exatamente **um POST ao n8n simulado**, guard aprovado, uma reserva liquidada, um fato/uma relação e zero deliveries. A base é nova e efêmera em cada caso; isso não reinicia nem altera o gate remoto.

Para exemplificar a sequência sem somar tempos sobrepostos, nos casos de modelo 3.000 ms:

| Marco relativo ao início | RTT 136,984 ms | RTT 10 ms |
| --- | ---: | ---: |
| Retorno do POST de envio | 2.396,292 ms | 207,589 ms |
| Fim do claim que encontrou o job | 3.099,272 ms | 1.147,847 ms |
| Início do intervalo de modelo | 5.628,495 ms | 1.367,433 ms |
| Fim de `dispatch`, incluindo gravação do ACK | 6.186,071 ms | 1.414,948 ms |
| Fim do intervalo de modelo | 8.629,989 ms | 4.368,267 ms |
| Commit da conclusão | 11.057,147 ms | 4.575,563 ms |
| Detalhe autorizado recebido | 12.177,197 ms | 5.280,181 ms |

O ACK/gravação de estado se sobrepõe ao intervalo do modelo em ambos. Com RTT menor, o worker também consegue varrer mais vezes enquanto aguarda: há mais viagens totais em alguns casos mais rápidos. Isso mostra por que contagem agregada × RTT não é caminho crítico. Os totais maiores que 63 incluem polls intermediários e ciclos ociosos; send permanece com 13 viagens e callback com 17 neste fixture.

### Decisão que o experimento permite — e a que não permite

O contrafactual controlado apoia a distância efetiva aplicação–banco como alvo de maior alavancagem: nesta simulação, somente trocar o atraso nominal por viagem reduziu o endpoint em cerca de 6,9/6,7 s. **Não é previsão de economia remota:** a simulação de 137 ms já termina antes das amostras publicadas, e várias parcelas de rede/autenticação/frontend estão ausentes.

Mesmo a combinação de RTT 10 ms e modelo de 3 s levou 5,280 s ao detalhe, antes de renderização. A combinação com modelo de 5,5 s deixou apenas ~0,231 s até o teto de 8 s, sem considerar as lacunas. Logo, não foi demonstrada viabilidade do aceite 5/8 s apenas mudando a localização do runtime. O harness também não testa aviso pós-commit ou outra arquitetura: essas hipóteses continuam propostas, não melhorias implementadas.

Próxima decisão: usar os marcos para planejar uma comparação local de mecanismo de descoberta/fila, se autorizada, e obter evidência da parcela Auth/HTTP antes de qualquer decisão operacional de infraestrutura. Nenhuma contratação, migração, cache de autorização, remoção de lock, aviso push ou mudança de modelo foi feita. O critério de fechamento permanece a bateria real M6, com seis turnos contextuais pré-registrados e todos os demais controles/aceites.

### TDD e verificação

1. RED: teste do fluxo completo falhou em `Latency harness not implemented`; GREEN: execução real offline passou com callbacks, memória, liquidação, sobreposição e privacidade dos dados reportados.
2. RED: RTT negativo era aceito e o teste falhou por ausência de rejeição; GREEN: duração não finita/negativa é rejeitada antes de abrir a base.
3. Refatoração limitada à organização de imports, seguida de nova execução: **2/2 testes passaram** (~1,34 s de suíte na última execução registrada). A matriz lenta não faz parte do CI; o teste usa atrasos curtos e verifica contratos, não metas de tempo frágeis.
4. TypeScript passou. Os quatro benchmarks foram executados separadamente e todos os seus resultados foram mantidos acima. Sem gasto, chamadas externas ou teste de navegador.
