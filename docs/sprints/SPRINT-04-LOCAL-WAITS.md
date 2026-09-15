# Sprint 4 — S4.08: esperas e viagens ao banco, trabalho local

Atualização posterior: a publicação isolada e as duas chamadas autorizadas foram executadas no [gate S4.08](SPRINT-04-WAITS-GATE-20260911.md). API/worker r3 e site v8 estão publicados; a fluidez não recebeu aceite e a correção de cidade omitiu uma resposta independente. Os resultados abaixo permanecem o registro histórico da etapa local, não o estado remoto atual.

Estado: **implementação e verificação locais concluídas em 11/09/2026**. Gabriel autorizou avançar com o sprint. Esta etapa não inclui publicação, consulta remota ou chamada paga, nem declara a latência resolvida.

## Preflight do backend

`Engine.dispatch` consolida os dois `SELECT` do preflight em **um `SELECT` com duas subconsultas**, preservando o mesmo `scoped` e as quatro transações do dispatch. A leitura continua verificando o gatilho e o histórico de áudio, sem alterar schema, orçamento, controles, locks, prompt, modelo ou o financeiro v2 preexistente.

O teste `tests/preflight-round-trip.test.ts` usou relógio virtual de **150 ms por viagem ao banco**, incluindo `BEGIN`, configuração do escopo, consultas e `COMMIT`. O RED registrou **750 ms em vez de 600 ms**; após a consolidação, ficou GREEN: **cinco viagens → quatro**, e a contagem de consultas observada no dispatch passou de **17 para 16**. São resultados do modelo controlado, não tempos medidos na VPS ou no navegador.

As quatro regressões do novo arquivo passaram. Cobrem gatilho `unsupported` fora da janela das 24 mensagens, áudio antigo, separação de conversas, ator humano, áudio já transcrito e colisão dos mesmos IDs de mensagem/conversa em outro tenant ou marca. A suíte consolidada passou **182/182 testes e TypeScript**.

## Polling do frontend

O ajuste desconta o tempo da requisição, medido com relógio monotônico, somente após resposta bem-sucedida com job ativo e aba visível. Mantém piso de espera de **500 ms** e cadência nominal entre inícios de requisição de pelo menos **2,5 s**, sem sobreposição na mesma cadeia. Timers reais podem sofrer arredondamento e atrasos do navegador; não é um limitador agregado de tráfego.

O primeiro teste exercita os hooks e handlers reais do componente com relógio/transporte simulados: leitura de 1.200 ms, snapshot pronto no instante 2.000 ms. O RED observou a resposta em **4.900 ms**; após a mudança o GREEN observou em **3.700 ms**, com duas leituras e no máximo uma em voo em ambos os casos. É tempo até a árvore renderizada pelo harness local, **não paint de navegador, chamada de modelo nem ganho remoto medido**. Não somar os 1.200 ms deste cenário aos 150 ms do cenário do banco como economia garantida E2E.

Os intervalos de **15 s ocioso**, **30 s em aba oculta** e **15 s após erro**, assim como o retorno inicial do POST, permanecem intactos. **Build e 133/133 testes do frontend passaram**; lint sem erros, mantendo os três avisos preexistentes. Nove regressões novas exercitam o componente, incluindo cancelamento na troca de sessão/desmontagem, resposta atrasada, rascunho e pausa humana coerente na lateral e no chat.

A compensação altera a carga potencial: a cadência nominal ativa pode chegar a **24 consultas/minuto**, em vez de aproximadamente `60 / (2,5 + RTT_em_segundos)`. Com RTT de 1,2 s e processamento contínuo, isso significa aproximadamente **48% mais consultas** (16,2 → 24/min), apesar das mesmas duas leituras no cenário curto descrito acima. O piso de 500 ms reduz essa frequência quando a requisição demora mais de 2 s. A regra não acelera consultas ociosas/ocultas ou após erros; tampouco constitui SLA global por aba ou limite agregado de tráfego. O rate limit existente de 180 requisições/minuto não foi alterado. A contenção real do banco deve ser observada no próximo gate.

Aumento relativo máximo teórico dessa cadência: 80% com RTT de 2 s. O limite do servidor usa `request.ip`; oito cadeias ativas já podem exceder 180/min. A configuração local não habilita `trustProxy`, então usuários atrás do proxy podem compartilhar o mesmo bucket — **inferência de configuração local, não inspeção do runtime remoto**. Não relaxar o rate limit automaticamente. A bateria remota proposta continua restrita a uma conversa e duas chamadas.

## Decisão de escopo

Worker e `Store.claim` **não foram alterados**: mexer no ciclo de claim envolve expiração de jobs e carga recorrente. `Briefings.dispatch` já executa **zero SQL no laboratório**, portanto não foi modificado. A etapa concentra-se nas viagens comprovadamente redundantes do preflight e na espera adicional do polling, preservando os gates existentes.

## Verificação e referência histórica

- Backend: ciclo RED → GREEN concluído; **182/182 + TypeScript aprovados**, incluindo quatro novos testes. Execução final: `npm run build && node --import tsx --test --test-concurrency=4 tests/*.test.ts`. O wall-clock dessa execução foi atípico (~3.832 s) e não foi usado como benchmark; os números de melhoria vêm exclusivamente do relógio virtual controlado. Uma regressão anterior havia passado 181/181 antes da última borda de colisão de escopos.
- Frontend: **build + 133/133 testes**, lint **zero erros/três avisos preexistentes**. Comandos: `npm test` e `npm run lint`; nenhum browser, servidor de preview ou QA de pintura/renderização real foi executado.
- Revisão independente: sem bloqueadores no SQL ou polling. Ressalvas de carga e limites da simulação registrados acima. Os testes orientaram mudanças pequenas e preservaram as garantias existentes; nenhuma regra comercial foi flexibilizada.
- Arquivos de implementação/teste: `sapore-sdr/src/engine.ts`, `sapore-sdr/tests/engine-timings.test.ts` (expectativa de queries 17 → 16), `sapore-sdr/tests/preflight-round-trip.test.ts`, `borelli-expansao/app/components/pilot-lab/tester-workspace.tsx` e `borelli-expansao/tests/tester-fluidity.test.mjs`. Nenhum pacote, lockfile, migração, worker, contrato ou credencial foi alterado.
- S4.08 concluída **localmente**; publicação e efeito real permanecem pendentes. Sprint 4 continua aberto.
- Ações remotas, publicações e chamadas pagas nesta etapa: **zero**.

A última referência remota é **histórica**, de 11/09/2026 às 16:51 UTC: API/worker r2 de instrumentação, site v7, 275.169 microUSD utilizados e 724.831 de saldo. Esse estado **não foi reconsultado agora** e não representa saldo atual garantido. O registro completo está no [gate de instrumentação](SPRINT-04-TIMINGS-GATE-20260911.md).

O financeiro v2, o aceite comercial, reviewer, logout/retomada e mobile autenticado continuam sujeitos às validações anteriores. Avançar localmente não autoriza novo deploy, relaxamento de gates ou gasto adicional.

Para o próximo gate, propor somente API/worker com esta alteração de preflight e frontend com esta alteração de polling, preservando n8n, modelo, audiência e teto total de R$ 10. Reconsultar o ledger antes de qualquer chamada paga; no máximo duas chamadas fictícias se autorizadas, comparáveis aos turnos anteriores e sem retries para perseguir saídas favoráveis. O pacote backend deve partir da r2 publicada e excluir o financeiro v2 local, como no gate de instrumentação. Não publicar a árvore local inteira inadvertidamente.
