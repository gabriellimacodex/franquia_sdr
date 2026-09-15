# Sprint 4 — Financeiro e tempos de execução, preparação local

Estado em 11/09/2026: o lote completo de **178 testes permanece local**, com financeiro v2 em rascunho. A instrumentação compatível foi posteriormente isolada e publicada por autorização específica, conforme o [gate de instrumentação](SPRINT-04-TIMINGS-GATE-20260911.md). S4.07 passou como instrumentação; o financeiro v2 não está no pacote remoto, tem zero versões no banco e não foi ativado. Sprint e latência continuam sem aceite final.

## Escopo

- Contrato financeiro v2 explícito e compatibilidade preservada com o contrato legado v1.
- Integração com a persistência em lote já entregue no primeiro lote do Sprint 4, sem nova migração ou mudança no helper.
- Tempos opcionais no callback n8n, separados das medições do backend e dos dados da conversa.
- **O lote local original teve zero operações remotas, publicações ou chamadas pagas.** A publicação posterior da instrumentação e suas duas chamadas de QA pertencem ao gate autorizado separado, descrito abaixo. Modelo, contrato comercial ativo e orçamento foram preservados.

## Contrato financeiro

`FinancialDecisionSchema` e `FINANCIAL_OUTPUT_JSON_SCHEMA` acrescentam `financialReply`, obrigatório e anulável. A estrutura identifica a evidência do capital, a fonte aprovada de investimento e a pergunta seguinte; a resposta financeira é montada pelo backend, distinguindo o capital declarado do preço de referência da franquia.

O reconhecimento de capital v2 cobre somente uma declaração explícita, atual e única de recursos próprios. Valores ambíguos, outras origens ou interpretações não cobertas exigem esclarecimento ou revisão humana; essa restrição de escopo não é uma regra financeira universal.

Quando a mensagem canônica atual contém capital reconhecido, continuar exige o plano financeiro inteiro e `bubbles=[]`, mesmo que o modelo omita propostas. Não há substituição de valores em texto livre. Stop/handoff preservam a ação com reconhecimento determinístico, sem promessas financeiras ou perguntas novas. O ramo livre fora dessa declaração mantém o guard comercial existente; não é uma prova de compreensão de toda alegação implícita em português.

Todas as propostas em campos financeiros (ou com unidade BRL) passam por conferência de valor exato, dono, origem e evidência, inclusive se o modelo escolher `financialReply=null`. Não se inferem soma, giro, intervalo ou recursos de terceiros. Substituições precisam apontar para fato compatível da própria memória; conflitos continuam pendentes e não apagam nem confirmam fatos. Fontes repetidas com o mesmo ID são rejeitadas como ambíguas.

O engine escolhe schema e guard pelo snapshot imutável do job, não pela versão ativa nem por campo enviado no callback. Rejeita v2 em job legado e downgrade para v1 em job v2. O campo opcional `outputContract` não materializa default no snapshot antigo, preservando seu hash. `createFinancialDraftSnapshot` gera conteúdo de rascunho local sem salvar ou ativar uma versão.

O JSON Schema mantém campos obrigatórios e `additionalProperties=false`, usando null quando o plano não se aplica, conforme o contrato de [Structured Outputs da OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs). Essa garantia de formato não substitui a validação de evidências no backend.

Os testes offline executam os códigos reais `prepare-job.js` e `parse-result.js` em uma VM, com resposta fictícia. Cobrem v2 com `financialReply` preenchido e nulo, além do legado v1 sem esse campo. Verificam que schema fornecido, resultado, versão, uso, modelo, instruções, limite de saída e formato do request são encaminhados sem alterações indevidas. Não são chamadas reais ao n8n ou ao modelo e não demonstram, sozinhos, qualidade comercial em produção.

Arquivo de regressão: [n8n-financial-contract.test.ts](../../tests/n8n-financial-contract.test.ts).

## Persistência em lote — entrega anterior preservada

O helper `persistLeadMemory` recebe a transação já aberta e mantém o escopo de tenant/marca/candidato do caller. Emite até uma consulta para fatos e uma para relações; coleções vazias não geram consulta. Todos os registros da memória são considerados para restaurar projeções ausentes. Fatos idênticos não recebem novo `updated_at`, usando comparação JSONB `IS DISTINCT FROM`; relações existentes preservam o conteúdo anterior.

Os testes cobrem evidências e status, isolamento, idempotência, restauração de linhas ausentes, mudanças reais, IDs repetidos e rollback com a transação do caller. A redução de consultas é comprovada localmente; não há medição de ganho remoto nesta etapa.

## Tempos e limites da medição

O evento existente `turn_completed` registra `timings.backend`: `preflightMs`, `prepareMs`, `budgetReservationMs`, `n8nAckMs`, `completeReadMs`, `guardMemoryMs` e `persistBeforeEventMs`, conforme disponibilidade. O backend usa relógio monotônico. Não foram acrescentadas consultas ou transações para telemetria. Os tempos do worker ficam no contexto privado e não entram no payload enviado ao modelo.

Se o callback chegar antes de o worker gravar o ACK, conserva-se somente `prepareUntilContextWriteMs`, junto dos tempos efetivamente medidos no callback. Essa medida parcial exclui a escrita de contexto e seu commit; ela não se soma ao preparo completo. O ACK tardio não reabre o job. Metadados de outra tentativa são ignorados. O evento e a liquidação de orçamento permanecem na transação existente.

O callback de conversa pode conter apenas `timings.modelRoundTripMs`, inteiro entre 0 e 180.000. O n8n marca o fim da preparação e mede até o início do processamento da resposta HTTP. A duração inclui a requisição e o overhead entre nodes; não representa inferência pura do modelo. Valores ausentes, inválidos, negativos ou fora do limite são omitidos, e o callback de briefing continua sem esse campo.

A telemetria permite somente a duração numérica. Não encaminha timestamps internos, texto, contexto, URLs ou campos de timing fornecidos pelo job ou pela resposta. As métricas reportadas pelo n8n devem permanecer identificadas como `n8nReported`, separadas das durações monotônicas do backend.

**Limitação:** os nodes usam `Date.now()`, um relógio de parede, não monotônico. A validação elimina anomalias evidentes, mas não detecta todo ajuste de relógio que produza um intervalo ainda válido. Estar na mesma execução do workflow não comprova relógio/processo único caso os Code nodes sejam distribuídos entre runners. Portanto, esses valores são diagnósticos aproximados, não SLA nem medição monotônica garantida. Nenhuma duração é calculada subtraindo timestamps do backend ou da OpenAI.

## Evidências locais

- Teste de transporte financeiro v1/v2: **2/2 aprovados**, incluindo a correção de tipagem pelo parse dos schemas correspondentes.
- Execução conjunta dos testes financeiros, segurança financeira, histórico n8n, transporte e timings: **17/17 aprovados** antes da correção exclusiva de tipagem; o transporte foi reexecutado e permaneceu aprovado.
- Helper de persistência: **5/5 aprovados**, com ciclos RED→GREEN para os comportamentos implementados.
- Os subconjuntos acima se sobrepõem a outras suítes; suas contagens não devem ser somadas como um total global.
- `npm run build` / TypeScript: **aprovado nesta execução**, após a correção de `forwarded` no teste.
- Verificação final consolidada em 11/09/2026, 16:33 UTC: **178/178 testes de backend e TypeScript aprovados**, usando `npm run build && node --import tsx --test --test-concurrency=4 tests/*.test.ts` (29,283 s de testes). Inclui as três integrações engine v2, os nove testes de segurança financeira e a compatibilidade de snapshots/n8n. A regressão anterior havia passado 177/177 antes do último caso de fonte ambígua.
- Os testes TDD e a revisão independente orientaram a validação cruzada de propostas, os controles determinísticos e a rejeição de fontes ambíguas. Nenhum teste real de modelo, navegador ou infraestrutura publicada foi executado neste lote. O aviso preexistente de depreciação do Fastify permanece; não houve atualização de dependências.

## Pendências e próxima sequência

A consolidação local foi seguida pelo gate autorizado de instrumentação, **já concluído**. O pacote remoto separado passou **158 testes e TypeScript**, e a imagem **32/32 testes na VPS sem rede/credenciais**. API/worker r2 foram ativados às **16:48:20 UTC**, na release `/opt/sapore-sdr/releases/20260911T164430Z/sapore-sdr`, imagem `sapore-sdr:sprint4-timings-20260911-r2`. O n8n publicou r2, UUID `98925a01-2172-4b07-9679-3f0938ffc65e`, às **16:48:35 UTC**. Frontend v7, audiência, modelo, snapshot comercial e guard permaneceram iguais. Os 178 testes da árvore financeira local não devem ser apresentados como a suíte do artefato remoto.

Foram executadas exatamente **duas chamadas pagas**, com E2E de **18,523 s / 15,133 s** e n8n reportado de **5,116 s / 3,021 s**. As referências anteriores eram 17,241 s / 14,413 s E2E: não houve melhora demonstrada, e a amostra não estabelece causalidade nem SLA. Os intervalos do backend não incluem todo o commit final, a fila inicial ou a consulta/renderização da interface; não formam uma decomposição exata do E2E. Memória e conflito foram preservados, e a pausa humana foi observada corretamente depois de uma espera interrompida, sem E2E preciso da pausa.

Leitura final somente leitura às **16:51:50.462983 UTC**: **24 reservas liquidadas, zero pendentes, 275.169 microUSD usados e 724.831 de saldo**, mesma cota de **1.000.000 microUSD** no gate `sprint3-continuous-20260910`. O incremento das duas chamadas foi **25.166 microUSD**. Zero jobs ativos, canais habilitados e deliveries; API/worker permanecem ativos. Não houve terceira chamada nem reinício do ledger.

A próxima micro-meta é **local**: modelar worker/fila/polling e viagens ao banco com latência controlada e TDD, preservando escopo, locks, orçamento e gates. Este fechamento não infere autorização para nova publicação ou gasto.

A instrumentação já permite observar etapas separadas, mas a latência completa segue sem aceite e o tempo E2E não pode ser atribuído integralmente à inferência. A homologação comercial, as rejeições anteriores, reviewer, logout/retomada e mobile autenticado permanecem sujeitos às evidências e aos critérios do projeto.

`Versioning.publish` mantém os gates reais existentes: **30 cenários × 2 por suíte e avaliação humana ≥ 4**. Eles não foram alterados nem declarados cumpridos para o financeiro v2. O draft não foi ativado nem gravado remotamente, não integra o pacote de instrumentação e tem zero versões no banco. O helper de memória pertence à entrega anterior, preservada neste lote; isso não ativa o contrato v2. Não há promessa de publicar novo snapshot sem cumprir esses gates.

Nenhum teste local desta etapa autoriza nova versão remota, troca de modelo, reinício de gate ou aumento de orçamento.
