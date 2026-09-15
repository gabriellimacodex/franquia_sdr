# Sprint 4 — Gate S4.09: resposta na correção de memória — 11/09/2026

Estado: **PUBLICAÇÃO E QA CONCLUÍDAS — cenário de memória aprovado, fluidez reprovada**. O gate autorizou somente o reparo da resposta de memória na API/worker e até duas chamadas fictícias pagas, após conferir o saldo. Foram utilizadas exatamente duas, sem terceira chamada. O cenário respondeu quem opera/decide e informou a correção pendente; a auditoria confirmou memória e controles íntegros. Não há aceite geral de paráfrases, condução ou encerramento do sprint.

## Escopo autorizado

- Publicar somente o reparo de memória da S4.09 na API/worker r4, preservando fatos, evidências, conflitos, controles e limites de saída.
- Manter frontend v8, n8n, modelo `gpt-5.4-2026-03-05`, prompt, snapshot comercial e contrato financeiro inalterados. Financeiro v2 não será incluído ou ativado.
- Preservar teto total de **R$ 10**, gate `sprint3-continuous-20260910` e cota de **1.000.000 microUSD** (US$ 1,00), sem reiniciar o consumo. O deploy deve manter `compose.lab-budget.yaml` e o mesmo gate/limite.
- Até **duas chamadas fictícias pagas** nesta bateria, limitadas pelo saldo. Não repetir chamadas para perseguir respostas favoráveis. WhatsApp/Kapso e demais canais externos permanecem desativados.

## Baseline confirmada

Consulta somente leitura informada em **2026-09-11 às 20:29:36.776152 UTC**:

| Item | Baseline |
| --- | --- |
| Reservas | 26 liquidadas; zero pendentes |
| Uso / saldo / cota | 300.907 / 699.093 / 1.000.000 microUSD |
| Jobs ativos / canais habilitados / deliveries | 0 / 0 / 0 |
| Modelo / hash comercial ativo | `gpt-5.4-2026-03-05`; hash ativo preservado |
| API/worker | r3: API saudável e pronta, worker em execução |
| Isolamento | Modo laboratório; flags externas desabilitadas |
| Frontend / n8n | v8 / instrumentação r2, sem alteração neste gate |
| Rollback backend | r3 preservada como referência de retorno |

A r3 é `sapore-sdr:sprint4-waits-20260911-r3`, release `/opt/sapore-sdr/releases/20260911T195600Z/sapore-sdr`. Identificação comercial e evidências anteriores: [gate S4.08](SPRINT-04-WAITS-GATE-20260911.md). Os números acima são a baseline, não o fechamento da nova bateria.

## Pacote e implantação

A S4.09 local tem **193 testes no histórico de verificação**; ver [relatório local](SPRINT-04-LOCAL-MEMORY-REPLY.md). O candidato isolado passou **173/173 testes e TypeScript**, `npm run check`, 84,805 s de suíte. Não confundir a árvore local completa, que inclui financeiro v2, com o pacote remoto restrito ao reparo de memória.

O pacote partiu da r3: 98 arquivos, 95 idênticos e somente `src/memory-reply.ts`, `tests/memory-reply.test.ts` e `tests/engine-memory-reply.test.ts` diferentes. RED foi reproduzido antes do overlay e GREEN após ele. O tar não contém financeiro v2, segredos, `.env`, dependências, symlinks ou metadados AppleDouble/xattrs. A comparação na VPS confirmou as mesmas três diferenças.

| Evidência | Estado |
| --- | --- |
| Artefato isolado | `/tmp/sapore-s409-backend.eLqG25/backend-s409-memory-only.tar.gz`; manifesto adjacente `s409-backend-manifest.json` |
| SHA-256 do tar, local e VPS | `0e365f0c1e9d926c11dcd761fc4f38df982108600dfdbf7fecb4a5e2d77115e5` |
| Testes/TypeScript do candidato | **173/173 + TypeScript aprovados** |
| Imagem/release ativa r4 | `sapore-sdr:sprint4-memory-20260911-r4`; `/opt/sapore-sdr/releases/20260911T203500Z/sapore-sdr` |
| Identidade da imagem | `sha256:ac266d05f80356c845e611551f3095e4e2d8f4d1127308aedfccf244d81e119a` |
| Testes offline da imagem | **30/30 aprovados**, 37,193 s, sem rede/credenciais, 1 CPU/1 GiB; memória, integração, budget e deployment |
| Hash do reparador | `66d269cc733c84800deb8bf13f0d76bddfac124e5de8157914c830a5e28d9d9d` |
| Engine preservado | `b84ee17b7136b5dcbf54b5825124cb0293596672cd6145998d70f606ed3763f0` |
| Ativação API / worker UTC | **20:34:24.697 / 20:34:24.677**, respectivamente |
| Saúde e isolamento pós-QA | API `running healthy`, `/ready=ready`, worker `running`, mesma r4; flags e orçamento preservados na conferência às 20:36 UTC |
| Modelo, snapshot, contrato e orçamento preservados | Confirmados no fechamento; financeiro v2 zero persistido/ativo |

A tentativa inicial de construir com rede desabilitada foi cancelada apenas na etapa de dependências; o build normal reutilizou a camada de dependências da r3 e passou. Não houve mudança de pacote/lockfile. A execução dos 30 testes permaneceu totalmente offline; nenhum serviço ativo foi interrompido nessa preparação. A r3 e seus arquivos Compose/orçamento foram conferidos e preservados.

O preflight foi repetido em **20:33:57.226759 UTC** imediatamente antes da ativação: mesmos 300.907 utilizados / 699.093 disponíveis, 26 liquidadas, zero reservas pendentes e zero jobs ativos. API/worker mantiveram `EXECUTION_MODE=laboratory`, `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false`, `RETENTION_ENABLED=false` e o mesmo gate/cota. `/health` retornou `ok`, ambiente `homologation`, `outboundEnabled=false`. A imagem r3 de rollback foi reconferida após a QA: `sha256:8574ea36fc36c1f2c97d8eab3fa4d1500f011496bbedc3c253081862e98fa9b8`.

## QA e critérios

Foi criada a sessão fictícia **`56f9e302-fb37-40f2-b1c8-f084af810e22`**, candidata **`d578e469-3377-4e1c-84d7-b52dc4e23368`**, às **20:34:41.983213 UTC**, com versão fixa `sapore-v1-a1a330f07cd0`. Testes anteriores foram preservados. Repetiu-se o perfil Marina/Caio e depois a correção Vila Aurora → Vila Horizonte com a pergunta explícita sobre operação/decisão. Ambos os turnos pagos foram enviados uma vez. Saudação e pedido de pessoa seguiram os caminhos gratuitos.

| Resultado | Estado |
| --- | --- |
| Sessão e duas respostas comparáveis | Executadas; IDs e auditoria detalhada abaixo |
| Resposta à pergunta | Presente na correção junto do aviso honesto; resultado persistido idêntico ao observado na UI |
| Pausa humana no chat/lateral | Sincronizada, composer desativado, teste deixado pausado; sem pessoa acionada |
| Tempos E2E e internos, tokens e custo | Registrados abaixo; latência acima da meta |
| Ledger, flags e decisão de manter/reverter | Preservados; **manter r4**, rollback r3 disponível |

| Caso | E2E até novo balão visível / pausa coerente | Observação UTC |
| --- | ---: | --- |
| Saudação gratuita | 3,684 s | 20:34:57.124 |
| Perfil, paga 1 | **18,625 s** | 20:35:28.017 |
| Correção, paga 2 | **14,984 s** | 20:36:00.296 |
| Pausa humana gratuita | 4,001 s | 20:36:11.974 |

O perfil recuperou Marina como operadora e Caio como participante da decisão, sem insistir em dinheiro; perguntou se Caio entra como sócio ou ajuda na decisão. A correção exibiu dois balões: o aviso canônico de revisão pendente e **“Até aqui, você mesma vai administrar a loja e o Caio participa da decisão, certo?”**. A resposta independente não foi omitida nessa amostra. Não foi observada a saída bruta anterior ao reparo, portanto a amostra não prova em qual balão ela originalmente estava nem atribui causalidade à mudança.

Comparação com r3: perfil 18,532 → 18,625 s; correção 14,333 → 14,984 s. **Meta de fluidez não alcançada**, sem prova de regressão causal ou melhoria geral. O Chrome mostrou resposta e pausa com campo preservado e histórico contido; a aba foi liberada ao final. Não houve publicação frontend, QA mobile autenticada, reviewer ou logout nesta bateria.

A meta de tempo aceita é **5 s típicos e até 8 s na bateria**; trata-se de objetivo de validação, **não SLA nem resultado já alcançado**. Duas chamadas não demonstram distribuição de latência ou causalidade. E2E exige observação contínua até o novo balão visível; tempos transacionais do banco excluem parte do commit, e o intervalo reportado pelo n8n inclui HTTP/overhead, não inferência pura.

Riscos preservados: frases sem separação segura mantêm fallback conservador; overflow pode exigir omitir um balão inteiro, sem cortar valores ou negações; o reconhecimento não cobre qualquer paráfrase. Não prometer que a omissão anterior foi causada por esse reparo: a saída bruta daquela execução não foi observada.

### Jobs, tempos e custo

Prefixo comum dos jobs: `lab-af971d69ef4427ea93b505cabe78dc63:`. Saudação: `35fdc625-5473-4635-93da-bf827a48a938`; perfil: `ae1a5d21-e40c-4d96-9d7b-b688fdcd5790`; correção: `5c5bd36d-204f-452b-b329-5a57308dc303`.

Ambos os pagos terminaram `completed`, uma tentativa, guard aprovado, erro nulo e `nextAction=continue`. A saudação terminou `completed`, zero tentativas, uso nulo e nenhuma reserva; criação **20:34:55.288988**, conclusão registrada **20:34:56.618123 UTC**, intervalo de **1.329,135 ms**.

| Medida | Perfil | Correção |
| --- | ---: | ---: |
| Criação UTC | 20:35:11.173553 | 20:35:45.849501 |
| Reserva UTC | 20:35:15.304581 | 20:35:49.994985 |
| Conclusão registrada UTC | 20:35:24.393257 | 20:35:56.989146 |
| Intervalo registrado no banco | 13.219,704 ms | 11.139,645 ms |
| Tokens entrada / saída / total | 2.081 / 578 / 2.659 | 3.219 / 216 / 3.435 |
| Reserva inicial microUSD | 52.743 | 60.508 |
| Custo liquidado microUSD | **13.873** | **11.288** |
| `preflightMs` | 606 | 589 |
| `prepareMs` | 1.385 | 1.340 |
| `budgetReservationMs` | 1.038 | 1.035 |
| `n8nAckMs` | 485 | 387 |
| `completeReadMs` | 1.545 | 1.956 |
| `guardMemoryMs` | 8 | 58 |
| `persistBeforeEventMs` | 986 | 982 |
| `n8nReported.modelRoundTripMs` | 5.415 | 2.543 |

Esses relógios não decompõem exatamente o E2E: métricas anteriores ao evento excluem liquidação/commit final, fila inicial e polling; `now()` no banco é início de transação. O valor reportado pelo n8n inclui HTTP/overhead e usa relógio de parede. Não atribuir o restante inteiro ao banco ou ao modelo.

### Memória, resultado persistido e pausa

A auditoria somente leitura de **20:37:05.507137 UTC** encontrou **cinco fatos e uma relação**, consistentes entre projeções e `lead_state`, com evidências canônicas da própria sessão. Nome Marina, Vila Aurora, operação pela candidata e participação de Caio na decisão permaneceram `declared`, sem confirmação humana, com `updated_at=20:35:24.393257 UTC` preservado.

Vila Horizonte permaneceu `conflict`, sem confirmação, em **20:35:56.989146 UTC**. Fato novo `24144207615a7a63927aa40e88473757a0faec65fe1a5e4a922d297c0c20364d`, `replacesFactId=756d6e87de3c68eb06fe555f7c9968d260c3c48983e4129d426e0954adba53bd`, correspondente à cidade original. Evidências com prefixo da sessão: perfil `043b451e-69ad-4795-bac4-c127566dbf77`, correção `aa2be90a-8dd8-4854-a875-a1b835e47d40`. A conferência em **20:37:50.319260 UTC** confirmou que os dois balões persistidos da correção correspondem literalmente aos observados na UI; não é a saída bruta pré-reparo.

Conversa `human`, epoch 1, desde **20:36:09.241267 UTC**; lead `handoff`, revisão 5; nove mensagens, quatro do candidato e cinco do agente. Briefing com o prefixo dos jobs e sufixo `971f1489-7c2b-4cb9-a13e-ce98f009833a`: `assignment_status=not_applicable`, `model_status=pending`, `usage=null`, `model_context=null`. Nenhum briefing pago ou acionamento externo registrado.

## Fechamento

Auditoria final de orçamento/invariantes em **2026-09-11 às 20:37:23.978144 UTC**:

| Item | Resultado |
| --- | --- |
| Gate / cota | `sprint3-continuous-20260910` / 1.000.000 microUSD, sem reset |
| Reservas | **28 liquidadas, zero pendentes** |
| Uso / saldo | **326.068 / 673.932 microUSD** |
| Custo desta bateria | **25.161 microUSD (US$ 0,025161)**, exatamente duas chamadas |
| Jobs ativos / canais habilitados / deliveries | **0 / 0 / 0** |
| Modelo / versão | `gpt-5.4-2026-03-05` / `sapore-v1-a1a330f07cd0` |
| Hash comercial | `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325` |
| Contrato / financeiro v2 | `outputContract=null`; zero versões financeiras v2 persistidas/ativas |
| Decisão operacional | **Manter API/worker r4**, site v8/n8n inalterados; rollback r3 conferido e preservado |

TDD e revisão independente orientaram a seleção exata dos arquivos e regressões, e as orientações Supabase/Chrome orientaram a auditoria restrita e observação sem acessar segredos. Nenhuma mudança de schema, audiência, autenticação ou fonte comercial foi feita. A revisão final independente não identificou overclaim material nem risco operacional adicional para reverter r4; os controles foram confirmados pela auditoria.

**S4.09 concluída no cenário validado; Sprint 4 continua aberto.** A fluidez permanece fora da meta aceita. Financeiro v2 exige homologação separada; reviewer, mobile autenticado, logout/retomada e aceite comercial geral também estão pendentes. Este fechamento não autoriza terceira chamada nem mudança de modelo, canal, contrato ou escopo; nenhuma próxima frente foi implementada/publicada automaticamente.
