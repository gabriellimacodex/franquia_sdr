# Sprint 4 — Gate S4.08: preflight e polling — 11/09/2026

Estado: **PUBLICAÇÃO E QA CONCLUÍDAS — sem aceite de fluidez ou condução comercial**. O usuário autorizou publicar somente o preflight da API/worker e o polling do frontend, com até **duas chamadas fictícias pagas**, ambas utilizadas. Este registro não declara melhoria geral de latência ou encerramento do sprint.

## Escopo e limites

- Backend: consolidar os dois `SELECT` do preflight em uma consulta com duas subconsultas, preservando escopo, transações, locks e controles. O ciclo do worker e `Store.claim` não mudam.
- Frontend: descontar o RTT monotônico na espera após leitura bem-sucedida de job ativo em aba visível, com piso de 500 ms e cadência nominal entre inícios de pelo menos 2,5 s, sem sobreposição na mesma cadeia. Intervalos ocioso/oculto/erro e retorno do POST permanecem intactos.
- Preservar n8n, modelo, prompt, versão comercial, guard, audiência e teto total já autorizado de **R$ 10**. Financeiro v2 não será incluído ou ativado; WhatsApp/Kapso permanecem desativados.
- Preservar a identidade `sprint3-continuous-20260910` e a cota de **1.000.000 microUSD** (US$ 1,00), sem reset. O deploy API/worker deve manter `compose.lab-budget.yaml` e o mesmo gate/limite.
- Até duas chamadas pagas nesta bateria, sem retries para buscar respostas favoráveis. Qualquer expansão de escopo exige nova decisão; este documento não a autoriza.

A implementação e os resultados simulados estão no [relatório local S4.08](SPRINT-04-LOCAL-WAITS.md). O pacote remoto partiu da r2 publicada, excluindo o financeiro v2 da árvore local.

## Baseline confirmada antes do gate

Preflight somente leitura informado em **2026-09-11 às 19:50:28 UTC**:

| Item | Baseline |
| --- | --- |
| API/worker | `sapore-sdr:sprint4-timings-20260911-r2` |
| Frontend | Site v7, commit `40537246749892cfd95751ce7eedee2ac08c2905` |
| n8n | Instrumentação r2 preservada; sem alteração autorizada neste gate |
| Modelo | `gpt-5.4-2026-03-05`, inalterado |
| Versão comercial/hash | Inalterados em relação ao gate de instrumentação |
| Financeiro v2 | Zero versões na baseline; sem ativação |
| Reservas | 24 liquidadas; zero pendentes |
| Cota / uso / saldo | 1.000.000 / 275.169 / 724.831 microUSD |
| Jobs ativos / canais habilitados / deliveries | 0 / 0 / 0 |

Estes valores são a baseline, não o fechamento deste gate. Identificação completa da versão comercial, hash e n8n: [gate de instrumentação](SPRINT-04-TIMINGS-GATE-20260911.md).

## Pacote e implantação

O pacote isolado do backend passou **162/162 testes e TypeScript**, conforme verificação informada pelo responsável pela execução. Não confundir essa seleção com a suíte da árvore local que contém financeiro v2.

| Evidência | Estado |
| --- | --- |
| Artefato isolado | `/tmp/sapore-s408-backend.N2ep4S/backend-s408-preflight-only.tar.gz` |
| SHA-256 | `2decabdc9698b6cb92ff3b8787308cbbc53d0782523747e82d8d4d72976765f3` |
| Comparação com r2 | 98 arquivos: 95 idênticos e três diferenças, incluindo um novo arquivo com quatro testes |
| Release ativa | `/opt/sapore-sdr/releases/20260911T195600Z/sapore-sdr` |
| Imagem ativa | `sapore-sdr:sprint4-waits-20260911-r3`; build aprovado |
| Testes da imagem na VPS | 23/23 aprovados em 70,626 s; sem rede/segredos, limitados a 1 CPU e 1 GiB |
| Ativação API/worker | **19:55:49.813 / 19:55:49.816 UTC**, respectivamente; API saudável e pronta, worker ativo; flags preservadas |
| Identidade da imagem observada | `sha256:8574ea36fc36c1f2c97d8eab3fa4d1500f011496bbedc3c253081862e98fa9b8` |
| Hash de `src/engine.ts` | `b84ee17b7136b5dcbf54b5825124cb0293596672cd6145998d70f606ed3763f0` |
| Publicação frontend | Site v8, deploy `SUCCEEDED` às **19:55:01.954 UTC**, na URL existente |
| Commit frontend | `d7ae860f45db76a76bffff7ae46342d8c5600301`, enviado ao repositório |
| Conferência de n8n/modelo/hash/financeiro v2 | n8n não alterado; modelo, versão, hash e contrato preservados; zero versões financeiras v2 persistidas/ativas |
| Referências de rollback | Backend r2 preservado, com image hash e hash do engine baseline conferidos; site v7 confirmado na listagem de versões, ID `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_ff3153b3e5348191af725fdbbc3d4dbb` |

O frontend foi preparado no clone isolado `/tmp/sapore-s408-site.ESTdsP/site`, com **somente dois arquivos alterados**. Build e **133/133 testes** aprovados; lint sem erros, com os três avisos preexistentes. Versão publicada: `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_433376b1f5d48191964ae28be62887fe`; deploy `appgdep_6aa45c871d60819185ba937d3086dfc1`. O JSON da audiência customizada, revisão 2, de Gabriel e João permaneceu igual antes e depois da publicação.

## QA e comparação

A comparação usou os turnos fictícios equivalentes de perfil e correção de memória do gate anterior, na sessão `1b7660c8-fef4-481d-99ea-d0fe8b5440c7`, candidata `d823adea-35bd-4fc0-9915-13c571899dc6`. O ledger foi novamente observado **inalterado às 19:56:56.961 UTC**, antes das chamadas pagas. Foram executadas **exatamente duas**, sem terceira chamada.

| Caso | E2E da baseline r2 | n8n reportado da baseline | E2E neste gate | n8n reportado neste gate |
| --- | ---: | ---: | --- | --- |
| Perfil | 18,523 s | 5.116 ms | 18,532 s | 6.575 ms |
| Correção | 15,133 s | 3.021 ms | 14,333 s | 2.797 ms |

Os E2E foram medidos continuamente no Chrome entre envio e observação visível:

| Caso | E2E | Visível UTC | Resultado observado |
| --- | ---: | --- | --- |
| Saudação determinística gratuita | 3,655 s | 19:56:51.329 | Abertura sem chamada ao modelo |
| Perfil | 18,532 s | 19:57:33.349 | Recuperou Marina/Caio, sem pedir dinheiro |
| Correção | 14,333 s | 19:57:56.514 | Avisou honestamente sobre a correção, mas não respondeu quem opera/decide; perguntou somente prazo |
| Pausa humana gratuita | 4,348 s | 19:58:14.961 | Pausa coerente no chat e na lateral, sem acionamento Kapso |

**Qualidade reprovada no turno de correção:** a pergunta explícita sobre operação/decisão ficou sem resposta. A saída bruta não foi observada; não se atribui essa omissão ao preflight ou ao polling. As diferenças E2E frente à baseline foram +0,009 s no perfil e −0,800 s na correção; não demonstram causalidade nem melhoria geral.

A sessão foi deixada pausada. No desktop **1470 × 756**, não houve overflow horizontal; a captura mostrou layout contido e composer preservado. Não houve QA mobile autenticada, reviewer ou logout nesta bateria. A abertura no painel do Codex estava indisponível; a QA foi concluída no Chrome. As skills orientaram a preservação da audiência e do escopo, e o TDD permaneceu restrito ao pacote aprovado.

### Jobs, tempos e memória persistida

Prefixo comum dos jobs: `lab-af971d69ef4427ea93b505cabe78dc63:`. Saudação: `1f1c9a42-c5c7-45be-bf19-49fce0d78bd2`; perfil: `608f9fde-e0e9-452d-91f6-4820c199631a`; correção: `d6176380-d4c8-44b2-804e-96a8579e5b75`.

Os dois jobs pagos terminaram `completed`, uma tentativa cada, guard aprovado e erro nulo. Isso não aprova a qualidade da resposta à pergunta independente. A saudação terminou `completed`, zero tentativas e uso nulo, sem reserva; intervalo registrado no banco de 1.355,383 ms.

| Medida | Perfil | Correção |
| --- | ---: | ---: |
| Criação UTC | 19:57:15.584378 | 19:57:42.810986 |
| Reserva UTC | 19:57:19.587276 | 19:57:46.698789 |
| Conclusão registrada UTC | 19:57:30.028592 | 19:57:52.988974 |
| Intervalo registrado no banco | 14.444,214 ms | 10.177,988 ms |
| Tokens de entrada / saída | 2.087 / 595 | 3.240 / 233 |
| Reserva inicial microUSD | 52.743 | 60.495 |
| Custo liquidado microUSD | 14.143 | 11.595 |
| `preflightMs` | 580 | 554 |
| `prepareMs` | 1.312 | 1.255 |
| `budgetReservationMs` | 984 | 970 |
| `n8nAckMs` | 509 | 381 |
| `completeReadMs` | 1.120 | 1.107 |
| `guardMemoryMs` | 5 | 3 |
| `persistBeforeEventMs` | 987 | 966 |
| `n8nReported.modelRoundTripMs` | 6.575 | 2.797 |

A conferência somente leitura encontrou **cinco fatos e uma relação**, coerentes entre projeções e `lead_state`, com evidências canônicas da própria sessão. Os quatro fatos originais — Marina, Vila Aurora, operação pela candidata e decisão com Caio — permaneceram `declared`, sem confirmação humana, preservando `updated_at=19:57:30.028592 UTC`. Vila Horizonte ficou `conflict`, sem apagar Vila Aurora. O novo fato `2fdd9984bbf9184f6f4d7ae962664edd920e2c75599cfd1737f60d8ec0b3b52e` aponta para substituir `cce182d1b91669ab3fdcce7958f9592213686a326dc6d92a2dd8d77680941cd1`.

Conversa `human`, epoch 1, desde **19:58:12.144471 UTC**, com nove mensagens: quatro do candidato e cinco do agente. Briefing terminado em `0802625d-2b46-43f7-b4e7-92ad0a5518e6`, `assignment_status=not_applicable`, `model_status=pending`, `usage=null` e `model_context=null`; nenhum briefing pago ou acionamento externo registrado.

Limites de interpretação:

- E2E é o intervalo do envio ao primeiro novo balão visível, observado continuamente. Checagem tardia ou interrompida não estabelece o instante exato de exibição.
- `n8nReported` inclui HTTP e overhead entre nodes, não inferência pura. Usa `Date.now()`, não monotônico; valores limitados não eliminam todos os ajustes de relógio ou divergências entre runners.
- Tempos internos do backend medidos antes do commit não são E2E. Não somar ou subtrair intervalos para atribuir todo o restante ao banco ou modelo.
- Duas chamadas são uma amostra limitada: não estabelecem SLA, distribuição de latência ou causalidade de eventual diferença. Ganhos dos relógios simulados não equivalem a ganhos remotos garantidos.
- O polling ativo pode chegar nominalmente a 24 consultas/minuto, antes aproximadamente `60 / (2,5 + RTT_em_segundos)`. Aumenta carga potencial; não é limite agregado por aba ou usuário. Rate limit permanece intacto e a contenção deve ser observada.

## Fechamento

Leitura final em **2026-09-11 às 19:59:11.873403 UTC**:

| Item | Resultado |
| --- | --- |
| Mesmo gate / cota | `sprint3-continuous-20260910` / 1.000.000 microUSD |
| Reservas | 26 liquidadas; zero pendentes |
| Uso / saldo | **300.907 / 699.093 microUSD** |
| Custo desta bateria | **25.738 microUSD (US$ 0,025738)**, exatamente duas chamadas |
| Jobs ativos / canais habilitados / deliveries | 0 / 0 / 0 |
| Modelo / versão / hash / contrato | `gpt-5.4-2026-03-05` / `sapore-v1-a1a330f07cd0` / `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325` / `outputContract=null`, todos preservados |
| Financeiro v2 | Zero versões persistidas/ativas; fora do pacote |
| Decisão | Manter API/worker r3 e site v8; rollback r2 preservado e conferido |

Publicação e QA foram concluídas, **sem aceite de fluidez/condução**. A amostra não demonstrou regressão causal que justificasse rollback, mas reprovou a resposta independente no turno de correção.

Uma reprodução adicional, somente em memória e sem editar código ou chamar provedores, confirmou quatro casos: `reconcileMemoryReply` substitui integralmente o primeiro balão em conflito novo, inclusive quando esse balão contém a resposta factual correta sobre Marina/Caio; a mesma resposta no segundo balão é preservada. Fatos e propostas continuam intactos. Os testes existentes cobriam a resposta independente no segundo balão. Isso demonstra um risco compatível com a omissão, **não a causa confirmada desta execução**, cuja saída bruta não foi observada. Esse reparador não foi alterado pelo preflight/polling.

Próxima micro meta proposta **S4.09, somente local**: adicionar regressão para a resposta independente no primeiro balão e corrigir o reparo preservando a resposta permitida, conflito, evidências, limites de resposta e controles. Não foi implementada nesta rodada; não inferir autorização para nova publicação ou chamada paga.

Sprint 4 continua aberto. Financeiro v2, aceite comercial, reviewer, logout/retomada e mobile autenticado não são concluídos por este gate. A elaboração deste documento não executou ações remotas, browser ou chamadas pagas.
