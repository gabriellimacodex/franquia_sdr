# Sprint 4 — executor HTTP e orçamento sequencial, somente locais

14/09/2026 UTC. **Meta ativa; Sprint 4 não concluído.** O turno anterior respondeu apenas ao pedido de status. Esta continuação implementou a conexão HTTP do controlador e a análise financeira do plano, sem chamadas remotas ao laboratório, modelos pagos, publicações ou mudança de acessos.

## Entrega e uso

`Sprint4Http` aceita uma credencial de sessão explicitamente fornecida em memória. Não lê navegador, cookies, ambiente, arquivos de credenciais ou senhas; não renova tokens nem oferece fallback para conta de serviço. Nenhuma credencial real foi fornecida ou usada nesta etapa.

- `identity`: consulta `/v1/me` e exige usuário esperado, escopo Sapore/homologação e papel admin retornados pela autenticação existente.
- `create-session`: cria sessão candidata pela rota administrativa de avaliação, ou sessão normal que fixa a versão ativa. Confere versão, rótulo, cenário e estado retornados. Não publica nem troca a versão ativa.
- `detail`: lê somente o ID de sessão solicitado, conferindo o vínculo de versão. O endpoint não comprova o hash/modelo completo, ledger ou aprovação.
- `advance`: chama internamente o controlador durável; somente seu `dispatch-once` válido pode produzir POST. Não aceita um comando público de envio arbitrário. Confere caso/texto canônicos, pins, identificadores, validade de envio e admissão; a checagem transacional do runtime continua soberana.

O transporte fica restrito a `https://sdr-api.cognitaai.com.br`, usa `redirect:error`, não possui retries e limita toda a leitura da resposta, inclusive corpo, a 10 segundos e 1 MiB. O timeout menor injetado nos testes não muda deadline de job ou limite de produto. Erros retornam códigos sanitizados; não carregam exceções, corpo bruto ou credenciais. `requestAttempted` refere-se à tentativa de **requisição mutável**, não às consultas GET.

`submission-confirmed` é somente uma observação de transporte vinculada à mensagem e ao job. Não contém reserva, custo, preparação, nota ou recibo de execução; `executionAudit` permanece `pending`. Resposta inválida/perdida ou erro após iniciar POST exige auditoria do mesmo requestId; a intenção durável já consumida impede novo envio no retorno ao controlador. Não se presume que `401`, `403`, `409` ou `500` autorize tentar novamente.

O ACK HTTP não é salvo automaticamente como `Receipt`: a API monta o detalhe antes do COMMIT, e o worker pode reservar antes de o cliente receber o JSON ainda marcado `pending`. Apenas auditoria privada do estado real pode estabelecer execução e gasto. Uma observação posterior aprovada não pode ser fabricada a partir desse ACK.

A [análise de orçamento sequencial](SPRINT-04-META-ORCAMENTO-SEQUENCIAL-20260914.md) acrescenta `analyzeBudget` ao planejador existente. Mantém tetos explícitos por turno, custos liquidados, reservas retidas e referência T1 separados; não desconta duas vezes valores já contabilizados no gate. Seu relatório nunca autoriza execução nem garante que a campanha completa caiba no saldo. Os T2 continuam sem bound medido; teto escolhido não é estimativa exata do payload futuro.

## Evidência e revisão

HTTP: **15 testes unitários**, com 14 ciclos incrementais RED→GREEN e uma regressão negativa já verde. Incluem identidade, credenciais inválidas, redirecionamento/tamanho/JSON, timeout durante o corpo, envio único, vínculos de resposta/admissão, expiração, criação candidata/publicada, leitura, falha de transporte, relógio inválido e exceções do parser. A revisão independente de Carson encontrou offsets de data impossíveis que Zod aceitava; o principal reproduziu a falha e adicionou a exigência de `Date.parse` finito aos timestamps HTTP.

O primeiro diagnóstico do corpo sem fim foi interrompido depois de confirmar que não encerrava. Em seguida, o teste ganhou timeout externo de 500 ms e reprovou por excedê-lo; a implementação passou com cancelamento em aproximadamente 20 ms. Essa interrupção inicial não é contabilizada como uma suíte aprovada. Dois avisos de TypeScript sobre `init` opcional foram corrigidos nos testes, sem relaxar as assertivas.

Carson escreveu e o principal leu/reexecutou duas integrações com Fastify real, PGlite com as três migrações e journal SQLite real. Autenticação Supabase, prontidão e n8n são explicitamente simulados e limitados aos endpoints esperados, sem fallback para rede:

1. O bridge segura o JSON `pending` após o POST, aciona o worker sintético e confirma a reserva no banco local **antes** de liberar o JSON. O executor mantém auditoria pendente, sem ledger/Receipt inventado; nova `advance` espera auditoria, sem segundo POST.
2. A membership da fixture é revogada após GET `/v1/me` e antes do POST. O código real de autorização da rota, com Auth simulado, reconsulta a membership local e bloqueia o envio, sem mensagem/job/reserva/admissão no banco. A intenção local permanece para auditoria, sem repetição.

Essas provas não incluem JWT remoto, rede/TLS, n8n/modelo reais, liquidação paga, qualidade financeira, latência de navegador ou aceite humano. Erros iniciais de fixture (`deliveries.id` inexistente e `Headers.entries` fora do lib configurado) foram corrigidos no teste; não são defeitos de produção ou RED funcional inventado. Integrações são regressões já verdes.

Subset HTTP final antes da consolidação: **17/17**, 2.088,93225 ms, zero falhas/skips/cancelamentos. Orçamento: dez novos testes, oito RED→GREEN e duas regressões; subset 17/17 com os sete testes anteriores do planner. A mesma borda de data foi reproduzida e corrigida na análise financeira após revisão. Carson liberou ambos os componentes; o principal conferiu o código, os testes e os hashes. Os subsets se sobrepõem à consolidada abaixo, não são números adicionais.

Consolidada da árvore final: **441/441 + TypeScript**, início `2026-09-14T01:19:18.620Z`, fim `01:20:26.595Z`, 65.129,170041 ms de testes, 70 arquivos de teste, zero falhas/skips/cancelamentos, exit 0. Manifesto de **150 arquivos**, estável durante a execução e reconferido depois. Não há suíte em execução neste processo encerrado; não repetir os testes por pedido de status.

- [TAP integral](SPRINT-04-META-HTTP-ORCAMENTO-REGRESSAO-20260914T011918620Z.tap): SHA-256 `888af65cc39f6219c64e5c266480316e26022706fa80e221f11a82ffa3177df6`.
- [Metadados e manifesto](SPRINT-04-META-HTTP-ORCAMENTO-REGRESSAO-20260914T011918620Z.json): hash do manifesto `7ce8e6f8b6843765378d58231ddfb064bcfbfae3ab2f3b5851eadd25a8a43741`; logs TypeScript/stderr adjacentes preservados.
- A consolidação anterior 414/414 permanece histórica e não foi reutilizada como prova da nova árvore. Nenhum `src/*` mudou neste recorte.

Nova [matriz determinística D01–D30 × 2](SPRINT-04-META-DETERMINISTICA-20260914T012033991Z.json): **60/60**, zero críticas, `01:20:33.991→01:20:42.920 UTC`, mesmo hash de candidato/modelo fixado, zero chamadas/rede/custo. Artefato SHA-256 `eca4f97bfa206a10d3476aa8d927e8a8b7b11bd4a2e1d57eefd2b7bc82fe64ec`, manifesto `11044471475222887fa2dcbc0bc5669a70b4a5790f460830f0a126743f8b3e55`. São callbacks construídos localmente, não avaliação conversacional real. Ambos os processos retornaram exit 0; nenhum teste/build/deploy ficou ativo ao fechar este checkpoint.

## Limites e próxima integração necessária

Este componente torna o POST real utilizável sem extrair tokens do navegador, mas **não é ainda o runner integral pronto para campanha**. Faltam composição com prontidão/ambiente privados verificados, armazenamento durável dos pedidos/resultados de criação e artefatos, reconciliação de criação ambígua, avaliação objetiva da resposta e conexão aos recibos auditados. Nenhuma aprovação humana será gerada por esse processo.

A criação recebe requestId explícito e não faz retry automático, mas seu ciclo durável ainda é responsabilidade do chamador. Não recuperar sessão por coincidência de rótulo, emitir novo ID ou criar outra sessão para contornar uma resposta perdida. O controlador já protege a intenção de envio, não o bootstrap inteiro da campanha. A leitura pública de detalhe não comprova todos os gates privados.

O fluxo live continua condicionado à autorização específica de Gabriel tester→admin, login/credencial de sessão por mecanismo autorizado, implantação verificada do protocolo runtime de admissão e gates reais de orçamento/versão. API/worker r8 e frontend v10 permanecem as últimas publicações verificadas; a admissão e estes adaptadores não foram publicados nesta etapa.

Última auditoria remota continua **00:27:41.083043 UTC**, sem nova consulta: 359.814 microUSD contabilizados / 640.186 disponíveis, 31 liquidadas, zero reservas desconhecidas/pendentes e jobs ativos. Não é saldo atual garantido. Nenhuma chamada paga iniciada pela equipe da meta neste turno; nenhum orçamento, modelo, schema, usuário, audiência, workflow ou canal externo alterado.

Ainda faltam campanha conversacional real, notas humanas e publicação financeira, M6 com mediana ≤5 s/todos ≤8 s, QA autenticada completa/papéis, revisão pessoal de João e aceite comercial de Gabriel. Proposta de infraestrutura permanece separada e não autorizada. Não encerrar a meta por aprovação das suítes locais.

## Fontes e skills

TDD orientou reproduções antes de correções; contratos tipados mantiveram fronteiras e erros explícitos; revisão focada evitou mudanças de produção neste recorte. A skill Supabase orientou preservar a autenticação remota existente e a consulta de membership, sem autorizar por metadados de usuário ou claims locais. O [changelog oficial](https://supabase.com/changelog) foi conferido; não foi identificada mudança aplicável a esta integração. A [referência oficial de getUser](https://supabase.com/docs/reference/javascript/auth-getuser), consultada pelo conector de documentação, confirma a validação da identidade via servidor Auth. Não foi instalado SDK nem alterada configuração Supabase.

## SHA-256 HTTP no freeze

| Arquivo | SHA-256 |
| --- | --- |
| `evaluations/sprint4-http.spec.ts` | `9b0d7b84d369fabb9bff80786e6a890f714ed1eaeac98fa46dd7c4f208088a62` |
| `evaluations/sprint4-http.ts` | `55891eeb281ea73c33dfefd03995aab0de9d4cf5469d4bf82a177c973cfa8410` |
| `tests/sprint4-http.test.ts` | `bb7fd1e561c09d42a25039cdbb56ae9d396d99709937e3c63c2328b42f5d90ee` |
| `tests/sprint4-http-integration.test.ts` | `8b9d0f0e2666bd1724c89da6e8c0defc61d27fead961b7209e0e811ac682fa93` |

Comparação com o manifesto da consolidada 414: nenhum `src/*` mudou; entre os 143 arquivos antigos, só `evaluations/sprint4-campaign.ts` recebeu alteração. Os sete novos arquivos de avaliação/teste constam do manifesto de 150 arquivos da consolidada 441. Histórico, pacotes publicados e evidências anteriores preservados.
