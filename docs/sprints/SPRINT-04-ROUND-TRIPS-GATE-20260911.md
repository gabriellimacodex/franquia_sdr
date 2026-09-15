# Sprint 4 — Gate S4.10: viagens ao banco — 11/09/2026

Estado: **PUBLICAÇÃO E QA CONCLUÍDAS — FLUIDEZ E CONDUÇÃO REPROVADAS**. O gate autorizou publicar somente a S4.10 na API/worker e até duas chamadas fictícias pagas. Foram utilizadas exatamente duas, sem terceira chamada. A auditoria confirmou memória, controles e orçamento íntegros; a correção permaneceu ambígua e não houve melhora de fluidez demonstrada. Decisão: manter r5, com rollback r4 preservado. Sprint 4 continua aberto.

## Escopo autorizado

- Agrupar as leituras de snapshot, lead e últimas 24 mensagens no preparo, sob o mesmo `scoped`, mantendo validações, datas normalizadas e recuperação de conhecimento separada.
- Inserir em lote somente os balões finais após guard/reconciliação, preservando IDs e ordem; zero balões não gera `INSERT`. No laboratório, `continue`/`nurture` grava diretamente `completed`; handoff/stop/rejeição e o caminho WhatsApp preservam seus estados.
- Manter transações, locks job → conversa → candidato, liquidação, isolamento e controles. Worker/claim, leases, deadlines, preflight, pool e schema não mudam.
- Preservar frontend v8, n8n instrumentado r2, modelo `gpt-5.4-2026-03-05`, prompt, snapshot e guard. **Financeiro v2 deve ficar fora do pacote remoto**, sem ativação.
- Preservar teto total de **R$ 10**, gate `sprint3-continuous-20260910` e cota de **1.000.000 microUSD**, sem reset de uso. Manter `compose.lab-budget.yaml` e o mesmo gate/limite no deploy.
- Até **duas chamadas fictícias pagas**, limitadas pelo saldo revalidado, sem retries para perseguir respostas favoráveis. WhatsApp/Kapso, audiência e contatos externos permanecem inalterados/desativados conforme a baseline.

## Baseline revalidada

A consulta somente leitura ao Supabase em **2026-09-11 às 21:23:59.158245 UTC** confirmou o mesmo ledger e invariantes do [fechamento S4.09](SPRINT-04-MEMORY-GATE-20260911.md). A conferência operacional na VPS confirmou a r4 publicada:

| Item | Baseline confirmada |
| --- | --- |
| API/worker | `sapore-sdr:sprint4-memory-20260911-r4` |
| Release / rollback deste gate | `/opt/sapore-sdr/releases/20260911T203500Z/sapore-sdr`; preservar r4 |
| Identidade da imagem r4 | `sha256:ac266d05f80356c845e611551f3095e4e2d8f4d1127308aedfccf244d81e119a` |
| Hash de `src/engine.ts` | `b84ee17b7136b5dcbf54b5825124cb0293596672cd6145998d70f606ed3763f0` |
| Hash do reparador de memória | `66d269cc733c84800deb8bf13f0d76bddfac124e5de8157914c830a5e28d9d9d` |
| Frontend / n8n | v8 / instrumentação r2; sem publicação autorizada neste gate |
| Reservas | 28 liquidadas; zero pendentes |
| Uso / saldo / cota | **326.068 / 673.932 / 1.000.000 microUSD** |
| Jobs ativos / canais habilitados / deliveries | 0 / 0 / 0 |
| Modelo / versão | `gpt-5.4-2026-03-05` / `sapore-v1-a1a330f07cd0` |
| Hash comercial | `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325` |
| Contrato / financeiro v2 | `outputContract=null`; zero versões financeiras v2 persistidas/ativas |

Na conferência da VPS, `/health=ok` e `/ready=ready`; ambos os containers preservaram modo laboratório, `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false`, `RETENTION_ENABLED=false`, o mesmo gate contínuo e a cota de 1.000.000 microUSD. Imagem, release e hashes acima foram conferidos, sem ativar a candidata.

Na captura pré-QA, o navegador mostrou a sessão anterior `56f9e302-fb37-40f2-b1c8-f084af810e22` pausada, sem nova sessão ou chamada paga naquele momento. Não houve publicação de frontend; v8 permanece a última versão registrada. Os números acima são a baseline deste gate, não seu fechamento.

O preflight imediatamente anterior à ativação, em **21:27:52.994103 UTC**, confirmou novamente **326.068 utilizados / 673.932 disponíveis**, 28 reservas liquidadas, zero pendentes, zero jobs ativos/canais habilitados/deliveries, modelo/hash preservados e zero financeiro v2. A ativação e a saúde posteriores estão registradas abaixo.

## Pacote e implantação

A [S4.10 local](SPRINT-04-LOCAL-ROUND-TRIPS.md) passou **207/207 testes e TypeScript**, com revisão independente sem achado material. Essa árvore contém financeiro v2 preexistente e não foi empacotada integralmente. O **pacote isolado passou 187/187 testes e TypeScript**, via `npm run check`, com 57,459926333 s de suíte; esse tempo de teste não é benchmark do produto.

| Evidência | Estado |
| --- | --- |
| Revalidação pré-gate de saldo, jobs e invariantes | Confirmada às 21:23:59.158245 UTC e repetida às 21:27:52.994103 UTC, sem alteração |
| Artefato isolado a partir da r4 | `/tmp/sapore-s410-backend.3GeTpw/backend-s410-batching-only.tar.gz`; manifesto adjacente |
| SHA-256 do pacote | `dadf0d0af623b8c41975a08149e0579c9c4c7d00a6ee036d98e570d77a11cdd0`, confirmado localmente e na VPS |
| Comparação com r4 | 101 arquivos: 95 idênticos e seis diferenças, confirmados na VPS; financeiro v2 ausente |
| Testes/TypeScript do pacote isolado | **187/187 + TypeScript aprovados** |
| Release ativa | `/opt/sapore-sdr/releases/20260911T212600Z/sapore-sdr` |
| Imagem ativa r5 | `sapore-sdr:sprint4-batching-20260911-r5` |
| Identidade da imagem | `sha256:e66372da2b8b8b40e900c8815d602a6b4dcd1d43ffc4e44f3232fec99205faec` |
| Build / TypeScript da imagem | Aprovados com Node 22 |
| Testes offline da imagem | **44/44 aprovados**, 77,602598495 s, sem rede/credenciais, 1 CPU/1 GiB |
| Ativação API / worker UTC | **21:28:22.393876656 / 21:28:22.394942682**, somente API/worker via Compose com overlay de orçamento |
| Saúde pós-start e pós-QA | `/health` e `/ready` aprovados após o start; por volta de 21:30 UTC, API saudável e worker em execução, flags/gate/cota preservados |
| Rollback r4 | Preservado e conferido: `sha256:ac266d05f80356c845e611551f3095e4e2d8f4d1127308aedfccf244d81e119a` |

Os seis arquivos diferentes são `src/engine.ts` (somente dois blocos), três arquivos novos de testes e dois arquivos com atualização das contagens esperadas. Hash do engine do pacote: `7904dd149ba5b6bbbd1dd841f0311e99799d492969a656734de77ef8aeb10332`. O reparador de memória permanece com hash `66d269cc733c84800deb8bf13f0d76bddfac124e5de8157914c830a5e28d9d9d`. SHA, manifesto, ausência de financeiro v2 e testes offline foram conferidos na VPS; somente API/worker foram implantados.

## QA executada e comparação

Foi criada a sessão fictícia **`f9c2af3b-4675-4198-9303-56031f472b4a`**, candidata **`cb384939-f848-4cdb-ab90-cbc424e2c186`**, repetindo perfil Marina/Caio e correção Vila Aurora → Vila Horizonte com pergunta explícita sobre operação/decisão. Sessões anteriores foram preservadas. Houve exatamente duas chamadas pagas; saudação e pausa humana seguiram os caminhos gratuitos.

| Caso | E2E anterior na r4 | E2E nesta r5 | n8n reportado r4 → r5 |
| --- | ---: | ---: | ---: |
| Perfil | 18,625 s | **19,547 s** | 5.415 → 5.457 ms |
| Correção | 14,984 s | **16,784 s** | 2.543 → 4.968 ms |

| Caso | E2E até resposta/pausa visível | Observação UTC |
| --- | ---: | --- |
| Saudação gratuita | 3,287 s | 21:29:00.491 |
| Perfil, paga 1 | 19,547 s | 21:29:29.276 |
| Correção, paga 2 | 16,784 s | 21:29:59.107 |
| Pausa humana gratuita | 4,075 s | 21:30:11.154 |

O perfil recuperou Marina/Caio sem insistir em dinheiro. O primeiro balão da correção foi persistido com uma quebra de linha real entre o aviso e o complemento ambíguo, igual ao conteúdo observado na interface:

```text
Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.
Perfeito, obrigada pela correção: vou considerar Vila Horizonte.
```

O segundo balão respondeu à pergunta independente:

> Pelo que você me disse até aqui, você mesma pretende administrar a loja e seu irmão Caio participa da decisão — é isso mesmo?

**Condução reprovada:** a resposta independente foi preservada, mas “vou considerar Vila Horizonte” cria ambiguidade contraditória junto do aviso de revisão pendente. A auditoria confirmou que a cidade nova permaneceu em conflito, sem substituir o fato anterior. Não se atribui causalidade ao batching; a saída bruta anterior ao reparo não foi observada.

A pausa ficou coerente no chat/lateral, com campo desativado; sessão deixada pausada, sem acionamento externo. O navegador foi finalizado e a aba liberada. Não houve publicação de frontend ou n8n nesta etapa, nem terceira chamada paga.

### Jobs, tempos internos e consumo

Prefixo comum dos jobs: `lab-af971d69ef4427ea93b505cabe78dc63:`. Perfil: `c904e7b7-1dc3-43aa-88fe-2183fe57b8de`; correção: `bb159822-5fcf-460d-90ec-9ec097208124`; saudação: `7b996ad4-ab89-482d-9d35-fd195700a52e`.

Os dois jobs pagos terminaram `completed`, uma tentativa, guard aprovado e erro nulo. Isso não aprova a condução. A saudação teve zero tentativas, uso e reserva nulos, com intervalo registrado no banco de **1.326,732 ms**.

| Medida | Perfil | Correção |
| --- | ---: | ---: |
| Criação UTC | 21:29:12.605984 | 21:29:43.947754 |
| Conclusão registrada UTC | 21:29:26.330580 | 21:29:56.161178 |
| Intervalo registrado no banco | 13.724,596 ms | 12.213,424 ms |
| Tokens entrada / saída / total | 2.083 / 598 / 2.681 | 3.246 / 236 / 3.482 |
| Limite de entrada usado na reserva | 13.897 | 17.007 |
| Reserva inicial microUSD | 52.743 | 60.518 |
| Custo liquidado microUSD | 14.178 | 11.655 |
| `preflightMs` | 569 | 556 |
| `prepareMs` | 1.052 | 987 |
| `budgetReservationMs` | 986 | 976 |
| `n8nAckMs` | 484 | 392 |
| `completeReadMs` | 1.964 | 1.122 |
| `guardMemoryMs` | 8 | 2 |
| `persistBeforeEventMs` | 725 | 714 |
| `n8nReported.modelRoundTripMs` | 5.457 | 4.968 |

A leitura parcial de **21:30:02 UTC** registrou **30 reservas liquidadas, zero pendentes, 351.901 microUSD utilizados e 648.099 disponíveis**, incremento de **25.833 microUSD** pelas duas chamadas. A auditoria final de **21:30:49.017620 UTC**, após a pausa, confirmou os mesmos valores e os invariantes descritos no fechamento.

Os E2E aumentaram 0,922 s no perfil e 1,800 s na correção frente à r4: **não há melhora demonstrada nem meta de fluidez alcançada**, mas duas amostras não estabelecem regressão causal ou SLA. O limite de duas chamadas não autoriza repetir a bateria até passar.

No teste local, quatro viagens a menos por turno com dois balões produziram **1.350 → 1.050 ms** no preparo e **2.550 → 2.250 ms** na conclusão, com RTT simulado de 150 ms. Não são ganhos remotos garantidos; a meta aceita de **5 s típicos/até 8 s na bateria não foi atingida nesta QA**. A meta não é SLA.

E2E exige observação contínua até o novo balão visível. Os tempos transacionais e internos não cobrem todo o commit/fila/polling; `n8nReported` inclui HTTP/overhead e usa relógio de parede, não mede inferência pura. Duas chamadas não demonstram distribuição de latência ou causalidade; não somar intervalos como decomposição exata do E2E.

### Auditoria da memória e pausa

A auditoria da sessão em **21:30:45.553165 UTC** encontrou **cinco fatos e uma relação**, iguais entre projeções e `lead_state`, com seis evidências exatas das mensagens canônicas da própria sessão. Os quatro fatos originais continuaram `declared`, `confirmedBy=null`, preservando `updated_at=21:29:26.330580 UTC`.

Vila Horizonte ficou `conflict` em **21:29:56.161178 UTC**. O fato `f95f839ce25a6c673e29a637c632658aaaee776bb26675f4ad84b9517e981a46` aponta `replacesFactId=f1b3d21d1c0a956a9dfdb8fc0b97ee741f0e61c16a9e11ccda0e070a8f635a3d`, sem apagar a cidade anterior. Qualificação `review`, motivo `unresolved_fact_conflict`; não houve confirmação humana de um fato conflitante.

A conversa ficou `human`, epoch 1, desde **21:30:08.379567 UTC**; lead `handoff`, revisão 5, nove mensagens: quatro do candidato e cinco do agente. Briefing com o mesmo prefixo dos jobs e sufixo `89034528-3fd9-40e0-9d1f-9e6ccac04848`: `model_status=pending`, `assignment_status=not_applicable`, uso/contexto nulos, sem processamento pago ou atribuição externa.

A revisão independente reproduziu localmente a frase ambígua com os reparadores r4 e r5, de hash idêntico: mesmas saídas e fatos, sem provedor ou escritas. Isso confirma a limitação preexistente para aquela entrada simulada, **não comprova a saída bruta da QA**. Reverter para r4 não elimina essa ambiguidade reproduzida.

## Fechamento

Auditoria final em **2026-09-11 às 21:30:49.017620 UTC**:

| Item | Resultado |
| --- | --- |
| Gate / cota | `sprint3-continuous-20260910` / 1.000.000 microUSD, sem reset |
| Reservas | **30 liquidadas; zero pendentes** |
| Uso / saldo | **351.901 / 648.099 microUSD** |
| Custo da bateria | **25.833 microUSD (US$ 0,025833)**, exatamente duas chamadas |
| Jobs ativos / canais habilitados / deliveries | **0 / 0 / 0** |
| Modelo / versão | `gpt-5.4-2026-03-05` / `sapore-v1-a1a330f07cd0`, preservados |
| Hash comercial | `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`, preservado |
| Contrato / financeiro v2 | `outputContract=null`; zero versões financeiras v2 persistidas/ativas |
| Decisão operacional | **Manter API/worker r5**, site v8/n8n inalterados; rollback r4 preservado |

Controles e memória permaneceram íntegros. A amostra não demonstrou melhora nem regressão causal atribuível ao batching; r4 também reproduz a ambiguidade local. **Publicação e QA concluídas; fluidez e condução reprovadas, sprint aberto.** Nenhuma próxima implementação ou chamada adicional foi executada nesta rodada.

TDD e revisão independente orientaram o pacote mínimo e os testes de regressão; as orientações Supabase/Chrome guiaram a auditoria restrita e a medição do comportamento visível, sem acessar segredos. Não houve migração, alteração de audiência ou publicação de frontend/n8n.

Este fechamento não autoriza alteração de modelo, frontend, n8n, financeiro v2, audiência, canais ou orçamento, nem terceira chamada paga. Reviewer, mobile autenticado, logout/retomada e aceite comercial geral continuam pendentes.
