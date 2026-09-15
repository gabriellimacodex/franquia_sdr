# Meta — concluir o Sprint 4 do laboratório Sapore

Preparada em 11/09/2026. **Instrução para ativação; a criação deste arquivo não inicia a meta, não publica nada e não autoriza gasto por si só.** As autorizações abaixo passam a valer somente quando Gabriel enviar uma instrução que ative a meta e adote expressamente este documento. Até lá, permanecem os limites anteriores.

## Objetivo e definição de conclusão

Concluir o Sprint 4 do laboratório SDR Sapore no projeto FRANQUIAS, corrigindo as reprovações de conversa, financeiro e latência, validando a aplicação publicada e obtendo os aceites humanos pendentes. Manter a plataforma atual.

Trabalhe de forma persistente entre turnos até cumprir os critérios de conclusão, dentro das permissões, orçamento e recursos disponíveis. Não pare para pedir “podemos avançar?” a cada microtarefa já abrangida por esta autorização. Planejar, passar testes locais, publicar ou terminar uma bateria não bastam para declarar o sprint entregue.

Não encurte o escopo, flexibilize critérios ou transfira pendências para outro sprint sem decisão explícita de Gabriel. Uma dependência humana ou financeira não é uma conclusão bem-sucedida. Esta meta não garante execução ininterrupta sem conectividade, acesso, recursos do Codex ou decisões humanas.

## Contexto a recuperar antes de agir

Diretório do projeto: `/Users/gabriellima/Documents/FRANQUIAS`.

Leia os arquivos de instruções aplicáveis e, nesta ordem:

1. Este documento.
2. `sapore-sdr/docs/implementation-status.md`.
3. `sapore-sdr/docs/sprints/SPRINT-04.md`.
4. `sapore-sdr/docs/sprints/SPRINT-04-ROUND-TRIPS-GATE-20260911.md`.
5. `sapore-sdr/docs/sprints/SPRINT-04-LOCAL-FINANCE-TIMINGS.md`.
6. `sapore-sdr/docs/sprints/SPRINT-03-QA-20260911.md`.

Use os demais relatórios quando necessários. Recupere o contexto dos arquivos e ferramentas disponíveis; não afirme ter lido conversas não acessadas. Use as skills aplicáveis conforme suas instruções.

### Última referência conhecida, não estado atual garantido

- API/worker r5: `sapore-sdr:sprint4-batching-20260911-r5`.
- Release: `/opt/sapore-sdr/releases/20260911T212600Z/sapore-sdr`.
- Frontend v8; n8n `SaporeAsyncV1Lab`, instrumentação r2.
- Modelo do produto: `gpt-5.4-2026-03-05`; não confundir com o modelo utilizado pelo Codex para programar.
- Snapshot: `sapore-v1-a1a330f07cd0`, hash `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`.
- Última auditoria: 11/09/2026, 21:30:49.017620 UTC. Uso de 351.901 microUSD; saldo de 648.099 microUSD na cota técnica de 1.000.000. Trinta reservas liquidadas, nenhuma pendente.
- Duas últimas respostas pagas: 19,547 s e 16,784 s E2E; a meta de fluidez não foi atingida.
- A frase “vou considerar Vila Horizonte” permaneceu junto do aviso de revisão pendente. O banco preservou o conflito; isso não torna a resposta aceitável.
- Financeiro v2 existe localmente, mas não estava publicado nem ativo.
- Rollback r4 preservado. Os relatórios contêm os hashes e as evidências.

Revalide versões, saldo, reservas, jobs e acessos antes de operações remotas. Inspecione a árvore de trabalho e preserve alterações existentes. Não publique a árvore local inteira por conveniência: ela contém trabalho não equivalente ao pacote remoto.

## Autorização operacional proposta para esta meta

Ao adotar este documento na ativação, autorizo o Codex a:

1. Inspecionar código, documentos, métricas e registros estritamente relacionados ao laboratório Sapore; fazer diagnósticos locais e remotos somente leitura.
2. Implementar e testar correções necessárias ao escopo do Sprint 4, incluindo memória, financeiro, latência, interface e regressões de autenticação/isolamento. Usar subagentes em tarefas independentes, com arquivos separados e revisão do responsável principal.
3. Publicar versões verificadas da API e do worker isolados na VPS Sapore, preservando rollback e os demais serviços da VPS.
4. Publicar o frontend no mesmo projeto Sites e na mesma audiência existente, exclusivamente para entregar e validar este sprint.
5. Alterar e publicar somente o workflow exclusivo `SaporeAsyncV1Lab` quando necessário a essas correções, com compatibilidade, backup/versionamento e rollback. Não alterar outros workflows ou credenciais por conveniência.
6. Preparar e publicar um novo snapshot financeiro v2 exclusivamente no laboratório, somente depois de cumprir os gates reais de versão, avaliação e aprovação humana descritos abaixo. Não sobrescrever o snapshot anterior, mudar fontes comerciais ou liberar números sem evidência.
7. Executar novas chamadas fictícias estritamente necessárias às avaliações planejadas, respeitando simultaneamente o saldo real do gate existente, a cota técnica e o teto total de R$ 10. Esta autorização, quando ativada, substitui o limite de duas chamadas da rodada S4.10 apenas para as novas avaliações desta meta; não cria saldo novo.
8. Reverter somente alterações feitas nesta meta quando a verificação mostrar regressão operacional ou de segurança. Não apagar dados, evidências ou histórico para executar rollback.

Essas autorizações não dispensam as aprovações técnicas exigidas pelo aplicativo ou ambiente. Não desabilite o sandbox, o controle de permissões ou a revisão automática para evitar uma aprovação.

### Limites que permanecem obrigatórios

- Manter `EXECUTION_MODE=laboratory`, `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false` e `RETENTION_ENABLED=false`.
- Manter WhatsApp/Kapso e envios/atribuições externas desligados. A pausa humana do laboratório não deve acionar uma pessoa externamente.
- Não enviar e-mails, convites, mensagens a terceiros ou executar briefing pago.
- Não trocar o modelo do produto, aumentar limites de saída ou contratar infraestrutura sem autorização específica. Propor e justificar se isso se mostrar indispensável.
- Não alterar usuários, memberships, audiência, cadastro público ou política de RLS/grants; corrigir código não autoriza ampliar privilégios. Uma mudança de política ou de configuração de autenticação requer aprovação própria.
- Não fazer migração remota de schema sem apresentar escopo, risco e plano de retorno e obter autorização específica. Não contornar essa condição com SQL avulso.
- Não inventar valores, regras comerciais, confirmação de fatos, fontes ou aprovações. Preservar evidências, isolamento, locks, transações, idempotência, deadlines e proteção de orçamento.
- Não expor segredos em arquivos, contexto público, mensagens, logs ou artefatos.
- Não migrar para Lovable/Replit, não ativar canais de produção e não acrescentar funcionalidades fora do sprint.

## Controle financeiro e recursos

O teto de R$ 10 é TOTAL, não adicional. Preservar o gate `sprint3-continuous-20260910`, a cota `LAB_BUDGET_LIMIT_MICRO_USD=1000000` e `compose.lab-budget.yaml` nos deploys.

Antes de cada bateria, registre finalidade, casos, quantidade máxima de chamadas e estimativa conservadora de reserva/custo. Antes de cada chamada, reconfirme disponibilidade suficiente, considerando gastos e reservas concorrentes. Contabilize falhas, retentativas e consumo desconhecido conservadoramente. Nunca reinicie o ledger, mude o ID do gate ou amplie a cota para continuar.

Prefira reproduções locais e respostas simuladas durante a investigação. Use chamadas reais somente quando elas produzirem uma evidência necessária que o teste local não fornece. Não repita a mesma chamada para selecionar uma resposta favorável; só faça nova rodada após mudança justificada ou como parte de uma bateria previamente definida, registrando também as falhas anteriores.

O saldo conhecido não garante que a homologação inteira caiba no orçamento. Calcule antes de iniciar avaliações extensas. Se faltar saldo, interrompa apenas as ações pagas, conclua o trabalho seguro restante e apresente o mínimo adicional necessário para decisão de Gabriel. Não execute a despesa esperando aprovação posterior.

Uso de tokens/limites do Codex é separado da cobrança da API do laboratório. Não altere orçamento de tokens ou limites do aplicativo por inferência. Ao alcançar um limite, preserve o estado e informe que a meta não foi concluída.

## Plano de execução persistente

### M1 — Baseline e plano de fechamento

- Revalidar o estado atual e listar os critérios restantes com suas evidências necessárias.
- Definir responsáveis por arquivos e tarefas; evitar agentes concorrentes editando o mesmo conteúdo.
- Identificar no início todas as dependências de João e Gabriel. Pedir os acessos/aceites necessários nesta conversa, sem contatar terceiros automaticamente, e continuar o trabalho independente enquanto aguarda.
- Registrar hipóteses, bateria prevista, estimativa de gasto e critérios de decisão antes de experimentar.

### M2 — Conversa e memória honestas

- Reproduzir localmente a ambiguidade observada e criar testes que falhem antes da correção.
- Corrigir a resposta sem afirmar que uma informação conflitante foi aplicada ou passará a ser usada como fato vigente antes da revisão humana.
- Preservar a resposta à pergunta independente, a cidade anterior, o novo conflito, os papéis de quem opera/decide e as evidências canônicas.
- Cobrir negação, paráfrases relevantes, conflito novo/repetido, duas mensagens, limites de tamanho, handoff, stop e replay. Não resolver removendo indiscriminadamente toda resposta útil.
- Não alegar compreensão de qualquer frase possível com base em uma lista finita de testes.

### M3 — Latência do fluxo completo

- Investigar envio → API → fila/worker → preparo → n8n/modelo → validação/persistência → retorno/polling → renderização.
- Usar os tempos existentes e instrumentar lacunas apenas quando necessário, sem levar conteúdo privado ao usuário/modelo ou adicionar custo desproporcional.
- Priorizar o gargalo demonstrado. Não acumular micro-otimizações sem hipótese, medida e critério de manter/reverter.
- Separar tempo visível no navegador, duração reportada pelo n8n, tempos internos e medidas simuladas. Não somar relógios incompatíveis nem chamar toda diferença de “tempo do modelo” ou “tempo de banco”.
- Não esconder a demora com um indicador, saudação fixa, redução da qualidade ou exposição de conteúdo ainda não validado.

### M4 — Financeiro e compatibilidade

- Resolver o falso bloqueio da declaração legítima de capital próprio sem permitir invenção de preços, giro, retorno, crédito ou disponibilidade de terceiros.
- Verificar o contrato financeiro v2 existente e os gates reais no código/documentação; não presumir que a implementação local já foi homologada.
- Preservar valor, origem, titularidade e evidência; pedir esclarecimento quando a informação for ambígua.
- Preservar os snapshots existentes e a compatibilidade v1/v2 por versão imutável do job. Publicar somente o novo snapshot que passar pelo processo correto.
- O gate documentado de publicação exige **30 cenários × 2 em cada suíte**, execução medida, zero violações críticas, modelo/hash corretos e **média humana ≥ 4 na suíte conversacional**. Conferir seu significado e implementação antes de executar; não reduzir esse gate, fabricar notas ou apresentar testes com mocks como avaliação real de modelo/humana. Não presumir que toda execução determinística corresponde a uma chamada paga: estimar a campanha real separadamente.
- Registrar validação e publicar exige um publicador com membership administrativa real. Verificar a autoridade disponível logo no início; não promover tester/reviewer, fabricar identidade administrativa nem contornar o processo por SQL. Se esse acesso não existir, solicitar a atuação de um administrador autorizado e prosseguir nas frentes independentes.
- Calcular o custo dessas avaliações antes de iniciá-las. A bateria curta de latência não substitui o gate financeiro. Se o gate não couber no saldo ou depender de dados/aceite indisponíveis, registrar a dependência e solicitar decisão, mantendo os demais trabalhos em andamento.

### M5 — Publicação controlada e validação integrada

- Rodar TDD, regressão completa aplicável, TypeScript/build/lint e revisão independente antes da publicação.
- Verificar o pacote exato: diff, manifesto/hash, ausência de segredos e de mudanças fora do escopo; testar a imagem em isolamento antes de ativá-la.
- Preservar uma versão conhecida para rollback em cada componente alterado. Registrar versões de API/worker, frontend, n8n, snapshots e respectivas compatibilidades.
- Revalidar saúde, orçamento e isolamento após cada deploy. Corrigir ou reverter regressões; não executar a bateria paga sobre um ambiente sabidamente inconsistente.
- Validar o frontend real autenticado em desktop e mobile, inclusive digitação, rolagem, envio, erro/timeout, pausa sincronizada, logout, novo login e retomada do histórico.
- Validar os papéis de tester e reviewer e a separação de acesso. Não usar credenciais de João nem se passar por ele. A validação pessoal dele precisa ser fornecida por ele; uma simulação automatizada não a substitui.

### M6 — Bateria final e encerramento

Para tornar “5 s típicos/até 8 s na bateria” verificável, usar como critério proposto desta meta uma bateria final registrada de **no mínimo seis turnos contextuais pagos**, distribuídos em pelo menos três sessões/cenários: conversa com memória, correção de informação e capital/financeiro. Incluir cenários com contexto acumulado, não apenas saudações.

- Medir continuamente o clique em Enviar → primeiro balão útil, visível e aprovado pelos controles. Registrar também quando a resposta completa fica disponível.
- Exigir mediana ≤ 5 segundos e cada um desses turnos ≤ 8 segundos; registrar todos os valores. Esse é o critério de aceite desta bateria limitada, não um SLA nem uma estimativa confiável de p95.
- Não mudar a seleção dos casos após ver o resultado. Uma correção posterior exige nova bateria identificada; não apagar o histórico reprovado.
- Interromper a avaliação de um candidato diante de falha crítica de segurança, isolamento, evidência ou orçamento; registrar a falha e corrigir antes de novas chamadas. Não continuar uma campanha sabidamente inválida apenas para completar a contagem.
- Executar somente se houver saldo para a bateria planejada. Os seis turnos podem contar em avaliações mais amplas apenas se os critérios de ambas forem realmente satisfeitos e a contabilização for explícita.
- Validar saudação gratuita e pedido de pessoa separadamente; não usá-los para melhorar a mediana dos turnos pagos.
- Exigir resposta coerente, informação financeira correta, memória íntegra, ausência de duplicações e de processamento indefinidamente pendente.
- Conferir ledger, reservas, jobs, deliveries, canais, evidências, saúde e rollback no fechamento. Nenhum job ou reserva desconhecida pode ser ocultado como aprovado.
- Obter o aceite de qualidade/comercial de Gabriel e a validação pessoal do reviewer. Preparar roteiro e evidências para reduzir o esforço humano; nunca inventar o aceite.

## Critérios cumulativos para marcar a meta como concluída

1. Reprovações conhecidas de memória/condução e financeiro corrigidas e verificadas na versão publicada.
2. Bateria final de latência aprovada conforme M6, sem relaxar os controles.
3. Gates de versão/financeiro realmente cumpridos, incluindo a avaliação humana exigida; snapshots anteriores preservados.
4. Desktop, mobile autenticado, logout/retomada, isolamento tester/reviewer e validação pessoal de João comprovados.
5. Nenhuma regressão crítica aberta em dados, segurança, autenticação, orçamento, idempotência ou operação do laboratório.
6. API/worker/frontend/workflow compatíveis e saudáveis; rollback documentado e disponível; WhatsApp/Kapso e demais ações externas continuam desligados.
7. Teto e ledger respeitados, todas as novas chamadas contabilizadas, sem reservas ou jobs sem explicação/encaminhamento verificável.
8. Aprovação comercial/humana de Gabriel registrada, sem substituí-la por autoavaliação.
9. Documentação e matriz final coerentes com a evidência, sem chamar implementação local de entrega publicada ou pendência de item concluído.

Se algum critério precisar mudar, apresente a razão e solicite a decisão de Gabriel antes. Não encerre o Sprint 4 nem marque a meta como completa só porque o trabalho técnico possível terminou.

## Continuidade, comunicação e impedimentos

Mantenha um registro vivo em `sapore-sdr/docs/sprints/SPRINT-04-META-PROGRESSO.md`, criado ao iniciar a execução. Registre o que passou/falhou, artefatos e versões, custos, decisões, dependências, próxima ação e instruções de retomada. Use-o após interrupções ou compactação de contexto para continuar, não reiniciar o trabalho.

Ao concluir uma microtarefa, escolha e execute a próxima ação segura abrangida pela meta. Dê atualizações curtas durante a execução e evidências após cada avanço material. Não peça autorização repetida para o que já está coberto; não suponha autorização para o que está fora.

Quando depender de saldo, acesso, aprovação do ambiente, mudança de escopo ou validação humana, faça um pedido específico, com impacto e decisão necessária. Continue tarefas independentes que ainda façam sentido. Se não restar progresso seguro possível, relate o impedimento real e use o mecanismo de bloqueio/retomada da meta conforme as regras do ambiente. Não contorne permissões nem invente trabalho para aparentar continuidade.

Um resumo ou pedido de status não é ordem para abandonar a meta. Uma instrução explícita de Gabriel para pausar, cancelar ou mudar o escopo deve ser respeitada.

## Entregáveis

- Código, testes e artefatos exatos das correções.
- Evidências de publicação, saúde, isolamento e rollback.
- Matriz completa de casos, resultados e latências, incluindo tentativas reprovadas.
- Prestação de contas de chamadas, reservas, custos e saldo final.
- Aceites humanos identificados, com data e escopo.
- Atualizações de `SPRINT-04.md` e `implementation-status.md` sem referências atuais contraditórias.
- Relatório `sapore-sdr/docs/sprints/SPRINT-04-ENCERRAMENTO.md`, com estado real: aprovado ou ainda pendente/bloqueado, jamais aprovado por conveniência.

Comece recuperando o contexto e revalidando a baseline. Em seguida execute M1 e avance pelas frentes independentes sem aguardar novos comandos de “vamos em frente”.

## Nota de configuração do Codex

O comando documentado é `/goal`. Para instruções extensas, a documentação orienta referenciar um arquivo no objetivo; o limite documentado do objetivo na CLI é 4.000 caracteres. O modo de meta mantém as permissões existentes e pode precisar de decisões do usuário. Não é necessário criar um cron ou uma automação recorrente para esta execução.

Referências: [trabalho de longa duração](https://learn.chatgpt.com/docs/long-running-work) e [comandos do Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
