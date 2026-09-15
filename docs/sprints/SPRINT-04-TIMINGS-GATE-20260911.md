# Sprint 4 — Gate de instrumentação de tempos — 11/09/2026

Estado: **instrumentação publicada e duas chamadas fictícias concluídas**. Este registro cobre somente a instrumentação. Não declara o sprint concluído, a latência resolvida ou a duração de inferência pura medida.

## Escopo autorizado

Ativar somente a instrumentação de tempos na API, no worker e no fluxo n8n correspondente, preservando modelo, versão comercial ativa, prompt, regras, orçamento e isolamento. A QA planejada usa uma nova sessão fictícia de Marina e no máximo duas chamadas pagas. O financeiro v2 não será ativado neste gate.

## Baseline somente leitura

Captura informada em **2026-09-11T16:42:04.349646Z**:

| Item | Baseline |
| --- | --- |
| Gate de orçamento | `sprint3-continuous-20260910`, identidade preservada |
| Cota | 1.000.000 microUSD (US$ 1,00) |
| Uso | 250.003 microUSD (US$ 0,250003) |
| Saldo | 749.997 microUSD (US$ 0,749997) |
| Reservas liquidadas | 22 |
| Reservas pendentes | 0 |
| Versão comercial ativa | `sapore-v1-a1a330f07cd0` |
| Hash ativo | `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325` |
| Modelo explícito | `gpt-5.4-2026-03-05` |
| Financeiro v2 | Zero na verificação da baseline; sem ativação neste gate |
| API e worker | Modo laboratório confirmado; WhatsApp, retenção e controle nativo desabilitados |

Os valores acima são a baseline deste gate, não um resultado pós-implantação. Nenhuma cota foi reiniciada por este registro.

## Pacote isolado e candidata

- Pacote: `/tmp/sapore-instrumentation.L844DH/backend-instrumentation-only.tar.gz`.
- SHA-256: `ab7b387bc2e247095d465737baf4b9d8cc6a04fe87aaac6b365fb4a2dfafbe8a`.
- Manifesto: **97 arquivos**, sendo **91 idênticos**, **4 alterados** e **2 novos testes** em relação à baseline comparada.
- Verificação local do pacote: **158 testes e TypeScript aprovados**.
- Release candidata na VPS: `/opt/sapore-sdr/releases/20260911T164430Z/sapore-sdr`.
- Imagem: `sapore-sdr:sprint4-timings-20260911-r2`.
- Build da candidata: **aprovado**. Ativada em **16:48:20 UTC**, somente API/worker, com os dois arquivos Compose e o mesmo overlay de orçamento.
- Imagem observada nos containers: `sha256:7590e34580c28e30037d9bfbfe03c45da664d229d1996e3744dfd073e6ca63a5`. Hash de `src/engine.ts` observado na API: `536a6465b8ec91c917ce0613f8b8ab5eb8171eaa1122e59a0518ddea0b9c6e7e`, idêntico ao artefato.
- **32/32 testes da imagem na VPS aprovados** em 103,684 s, sem rede/credenciais, com CPU/memória limitadas. Incluem orçamento, capital legado, memória, latência por contagem, histórico e novos tempos.
- Verificação posterior à QA: API `running healthy`, `/ready=ready`, worker `running`; modo `laboratory`, `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false`, `RETENTION_ENABLED=false` e mesmo gate/limite confirmados em ambos.
- Rollback de backend: release r1 em `/opt/sapore-sdr/releases/20260911T151642Z/sapore-sdr`.

## n8n e rollback

A baseline n8n é a r5, versão `b1577cd8-8b17-4822-9cb6-79f80561548b`. O histórico disponível é limitado a um dia; os códigos antigos devem ser salvos como evidência de baseline antes da alteração.

| Evidência | Estado |
| --- | --- |
| Códigos n8n anteriores | Copiados pelo editor visível e comparados byte a byte após trim com `integrations/n8n/nodes/{prepare-job,parse-result}.js` da baseline r1; `prepare-job` usa a origem real da API no placeholder |
| Diff restrito à instrumentação | Dois Code nodes alterados; ambos relidos pelo editor e iguais ao pacote isolado. Os outros três nodes e credenciais não foram alterados |
| Nova versão n8n publicada | `Sprint 4 — instrumentação de tempos r2`, UUID `98925a01-2172-4b07-9679-3f0938ffc65e`, publicada às **16:48:35 UTC** |
| Referência de rollback n8n | UUID baseline acima e arquivos na release r1 preservada em `/opt/sapore-sdr/releases/20260911T151642Z/sapore-sdr/integrations/n8n/nodes/`; cópia local extraída em `/tmp/sapore-instrumentation.L844DH/baseline/sapore-sdr/` |

Publicação confirmada no [histórico do workflow exclusivo](https://sdr-n8n.cognitaai.com.br/workflow/SaporeAsyncV1Lab/history/98925a01-2172-4b07-9679-3f0938ffc65e). Nenhum outro workflow foi publicado ou executado. Frontend v7, audiência, modelo, prompt, schema comercial e limite de saída permaneceram intactos; financeiro v2 nem sequer integra o artefato implantado.

## QA executada

Foi criada somente a sessão fictícia `8e287ea0-f576-4597-9646-a4ae8bb03414`, candidata `22f6cc91-bac1-436f-8297-183a9e979326`, preservando os testes antigos. Ordem:

1. Enviar `oi`, usando a abertura determinística sem modelo ou custo.
2. Informar o mesmo perfil da comparação anterior: Marina operará a loja; Caio, seu irmão, é o decisor; ela não quer falar de dinheiro. Primeira chamada paga, no máximo.
3. Corrigir Vila Aurora para Vila Horizonte e perguntar quem operará a loja e quem decide. Segunda chamada paga, no máximo.

4. Pedido humano gratuito: `Quero falar com uma pessoa da equipe.` A sessão foi deixada pausada, sem acionamento externo.

Texto da chamada 1: “Sou Marina Teste. Quero abrir na cidade fictícia de Vila Aurora. Eu mesma vou administrar a loja e meu irmão Caio participa da decisão. Não quero conversar sobre dinheiro agora.”

Texto da chamada 2: “Corrigindo: a cidade é Vila Horizonte, não Vila Aurora. Antes de avançar, quem vai administrar a loja e quem participa da decisão?”

A resposta do perfil identificou Marina na operação e Caio na decisão, sem cobrar valores; perguntou o estado. Na correção, o primeiro balão informou que a nova cidade foi registrada para revisão e o dado anterior ainda não foi substituído. O segundo recuperou Marina/Caio corretamente e voltou à pergunta do estado, sem insistir em dinheiro. Não houve mistura com outra sessão nem `POLICY_GUARD` nesses turnos. Isso valida esta amostra de continuidade, não toda a condução comercial.

Verificação somente leitura às **16:52:18.410729 UTC**: quatro fatos do perfil permaneceram `declared`, com `updated_at=16:50:21.680889 UTC`; a nova cidade ficou em `conflict`, com `updated_at=16:50:52.601672 UTC`. Cinco fatos e uma relação com Caio no total. Conversa `human`, epoch 1, nove mensagens; briefing `assignment_status=not_applicable`, `model_status=pending`, `usage=null`, `context=null`, sem processamento pago ou atribuição externa.

A correção aponta `replacesFactId=26d18bda7fb52154c39eff2481e29d8e567708db0c473c139932815293a10da7`, correspondente a Vila Aurora. As evidências usam mensagens desta mesma sessão, terminadas em `818de83c-6663-4bf1-811f-f28e13ec7f11` e `8a14062f-9242-4d95-aa2c-072889852972`. Controle humano registrado às **16:51:10.519040 UTC**, sem novo job ou reserva. O briefing pendente termina em `8679fc0c-1f6e-45ee-8cc8-95538c926b1e`.

## Comparação e limites das métricas

As referências anteriores são **17,241 s** e **14,413 s E2E**, respectivamente perfil e correção. Agora foram **18,523 s** e **15,133 s**: diferenças de +1,282 s e +0,720 s. Dois turnos não estabelecem regressão causal nem ganho de desempenho; a instrumentação não era uma otimização.

- `n8nReported` mede o intervalo reportado pelo n8n, incluindo HTTP e overhead entre nodes; **não representa inferência pura**.
- Os nodes usam `Date.now()`, que não é monotônico. Limites e omissão de valores inválidos não detectam todos os ajustes de relógio; uma execução distribuída também não comprova relógio único.
- A duração registrada pelo backend não inclui o commit quando a medição termina dentro da transação. Deve ser identificada separadamente do tempo E2E percebido no navegador.
- O E2E deve ser medido do envio até a resposta visível em uma única observação contínua. Observação interrompida ou conferência tardia não fornece o instante exato de exibição.
- Amostras individuais não estabelecem SLA, distribuição de latência ou solução definitiva do desempenho.

## Medições observadas

| Caso | Envio → primeiro novo balão visível | Visível UTC | Intervalo dos timestamps do job | n8n reportado | Entrada / saída | Custo microUSD |
| --- | --- | --- | --- | --- | --- | --- |
| Saudação gratuita | 2,557 s | 16:49:57.068 | 1,333220 s | Não se aplica | Sem modelo | 0 |
| Perfil | 18,523 s | 16:50:25.275 | 13,316572 s | 5,116 s | 2.085 / 572 | 13.793 |
| Correção | 15,133 s | 16:50:55.806 | 10,575841 s | 3,021 s | 3.205 / 224 | 11.373 |

Os dois turnos pagos terminaram `completed`, uma tentativa cada, sem erro, zero tokens de raciocínio e zero tokens de cache reportados. A observação E2E foi contínua entre clique e novo balão visível; a coleção de balões foi contada antes de selecionar o novo índice. Mede o primeiro balão, não uma suposta duração exclusiva da geração.

Prefixo comum dos jobs: `lab-af971d69ef4427ea93b505cabe78dc63:`. Sufixos: saudação `5b24d7d3-b8fb-4a6b-9800-09cb3f8f5177`; perfil `1378d754-5338-4b71-b2a7-8c7da9629ff2`; correção `14eb3ef8-b462-400a-8be7-c33fa6c9d7df`.

| Duração do backend (ms) | Perfil | Correção |
| --- | ---: | ---: |
| `preflightMs` | 707 | 695 |
| `prepareMs` | 1.321 | 1.262 |
| `budgetReservationMs` | 983 | 971 |
| `n8nAckMs` | 621 | 385 |
| `completeReadMs` | 1.356 | 1.124 |
| `guardMemoryMs` | 12 | 3 |
| `persistBeforeEventMs` | 1.059 | 983 |

**Leitura diagnóstica:** a lógica local de guard/memória consumiu milissegundos, enquanto preparo, reserva, leitura e persistência consumiram centenas de milissegundos a mais de um segundo por intervalo. A demora E2E não pode ser atribuída integralmente ao modelo. O próximo recorte é examinar viagens e transações sequenciais do backend/banco e a lacuna fila/commit/consulta da interface, preservando escopo, locks, orçamento e publicação somente após validação. Não subtrair/somar métricas para rotular toda a sobra como “tempo do banco”: há intervalos não medidos e possível sobreposição com o ACK.

O controle humano foi enviado uma única vez. A espera automática pela lateral expirou; a observação seguinte às **16:51:20.597 UTC** encontrou pausa correta, campo desabilitado, histórico de nove mensagens e aviso explícito de que ninguém foi acionado na Kapso. Como a observação foi interrompida, **não há E2E preciso da pausa** nesta rodada; 11,778 s é somente o limite até a conferência tardia, não o instante da transição. Não houve reenvio nem chamada paga adicional.

## Fechamento

| Campo | Resultado |
| --- | --- |
| Ativação e saúde API/worker | r2 ativa às 16:48:20 UTC; API saudável e pronta, worker ativo |
| Versão n8n | r2 publicada às 16:48:35 UTC, identificada acima |
| Versão comercial/hash/modelo e isolamento | Preservados; conferência pós-restart às 16:49:28.326768 UTC |
| Sessão, jobs, tokens e durações | Registrados acima; duas chamadas pagas usadas, nenhuma terceira |
| Continuidade | Aprovada nesta amostra; financeiro v2 não exercitado |
| Gasto das duas chamadas | 25.166 microUSD (US$ 0,025166), sem reiniciar cota |
| Reservas, uso e saldo final do mesmo gate | Às **16:51:50.462983 UTC**, 24 reservas liquidadas, zero pendentes; **275.169 microUSD usados**, **724.831 disponíveis** do mesmo limite de 1.000.000 |
| Canais habilitados e deliveries após QA | Zero canais habilitados, zero deliveries, zero jobs ativos; snapshot/hash/modelo inalterados e zero versões financeiras v2 gravadas/ativas |
| Comparação com 17,241 s / 14,413 s | 18,523 s / 15,133 s; sem aceite de fluidez |
| Decisão final | Manter r2 instrumentada; rollback r1 preservado. Não há regressão de segurança identificada nesta bateria |

Sprint 4 continua aberto. Financeiro v2 permanece somente local, sujeito aos gates de versão/qualidade existentes; não foi gravado nem ativado remotamente. Mobile/reviewer/logout e aceite comercial continuam pendentes. Este gate não autoriza novas chamadas pagas além das duas já executadas.

Próxima micro meta proposta, ainda não implementada neste gate: simular localmente o ciclo serial de `worker.ts`/`Store.claim` e a atualização da conversa (polling posterior à requisição), usando latência controlada e transporte fictício. Identificar uma espera ou consulta redundante, demonstrar RED → GREEN e regressão, sem reduzir locks, isolamento, orçamento, validação de conteúdo ou controle humano. A eventual publicação ou nova bateria paga exige o próximo gate definido, não uma terceira chamada nesta rodada.
