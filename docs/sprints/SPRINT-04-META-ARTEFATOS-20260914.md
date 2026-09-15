# Sprint 4 — evidências terminais e preparação da revisão

Etapa **implementada, revisada e consolidada localmente**, 14/09/2026 às 03:08:42 UTC. O checkpoint anterior concluiu a recuperação de sessões; esta continuação conecta auditoria terminal, arquivo privado e revisão parcial de respostas. Não houve credencial real, operação remota, modelo, publicação, mudança de acesso ou gasto. Não é encerramento do sprint.

## Fluxo implementado

1. `Sprint4EvidenceCapture` valida o plano canônico e sua admissão no journal. Procura primeiro o arquivo do turno; registro existente compatível é reutilizado sem reconsultar uma memória que pode ter avançado.
2. Sem arquivo, chama o auditor existente por dependência explícita. Vincula a observação ao plano, run, turno, ator, versão, sessão, candidato, request, job, mensagens, preparação e ledger. Grava e relê o arquivo antes de devolver `awaiting-review`.
3. Perda da confirmação local não autoriza nova coleta ou envio quando o registro durável pode ser recuperado. Arquivo divergente/corrompido não é substituído; falha de leitura não é tratada como ausência. Erros do auditor conservam seu código seguro, sem mensagens privadas.
4. `Sprint4ReviewPacket` lê os artefatos requeridos até o turno solicitado. T2 exige T1 da mesma execução, sessão/candidato, pins e ordem; recusa falta de predecessor ou mistura de repetição/run/input. Apresenta os arquivos e verificações O1–O8, com cada achado vinculado ao turno e digest exatos.

O retorno mantém `objectiveAudit=pending`, `readyForReceipt=false` e notas/identidade/data humanas nulas. **Não cria Receipt, validação, publicação, envio ou nota humana.** O controller continua `awaiting-receipt`. Arquivar não implementa sozinho o gate final de produção: o controller ainda confia no recibo recebido e não resolve `responseArtifactRef`. A futura composição precisa exigir o arquivo e as avaliações antes desse recibo; não alegar que estes componentes isolados já bloqueiam qualquer caller arbitrário do controller.

## O que o arquivo preserva — e o que não comprova

O payload v1 contém admissão, hash do plano e DTO terminal v2 completo, incluindo resposta **persistida/renderizada**, memória observada na revisão do job, guard/reparo/violações, preparação e ledger. O digest é calculado sobre a representação validada, conferido na leitura e não é assinatura externa nem prova da verdade semântica dos dados.

`rawArtifact=unavailable/not-retained-by-runtime` refere-se ao callback bruto completo não retido nesse contrato. Não copia `job.result` para um falso bruto nem reconstrói `financialReply`; o contexto privado do runtime pode conter diagnóstico parcial de rejeição, mas isso não equivale ao callback completo. Snapshot/fontes completas, resposta/execução independente do provedor, estado anterior a T1, `facts.updated_at`, configurações globais e renderização do navegador não são acrescentados por inferência.

Uma observação posterior coerente conserva a memória vista no instante da coleta, mesmo após avanço do banco. Não vira fotografia nativa imutável produzida pelo runtime na conclusão do job. Uma auditoria que já falhe por `MEMORY_ADVANCED` sem arquivo anterior não pode ser reconstruída. Falhas que não produzem DTO terminal válido retornam código sem artefato terminal; o executor ainda precisa conservar seu registro de tentativa/interrupção e reconciliar job/reserva.

O pacote de revisão confere apenas recortes mecânicos: citações literais nos inputs arquivados, identidade/projeções, ausência de confirmação humana comprovada pelo próprio pacote, preservação dos DTOs anteriores, aritmética de reserva/liquidação e timestamps de conclusão versus deadline. Citação existente não demonstra atribuição/extração corretas. Preservação de `createdAt` no DTO não comprova `facts.updated_at`. Tempo transacional não é commit nem resposta visível. Os oito critérios continuam parciais ou dependentes de pessoas/evidência adicional, nunca globalmente aprovados.

Guard do modelo reprovado e violações originais continuam achados mesmo quando o texto final foi reparado. O2/intenção e O8/qualidade exigem julgamento humano real; O4 precisa das fontes/pins e revisão comercial. Valores de fixtures não são resultado do modelo, capital real ou nota de pessoa.

## Armazenamento privado

`Sprint4EvidenceStorage`: SQLite dedicado, diretório absoluto de proprietário atual em 0700, arquivo 0600 regular, sem symlink/hardlink e com inode conferido. Inicialização explícita somente em diretório vazio; reabertura não cria, limpa ou migra. App ID e versão do formato próprios, verificação de integridade, transações INSERT-only, chave única run/turn e unicidade de job/request/reserva entre turnos. O run fixa plano/ator/target. Replay canônico exato não altera bytes do artefato; conteúdo diferente conflita.

COMMIT precede confirmação. Se COMMIT/ROLLBACK falharem, o handle fica em quarentena antes de tentar fechar; nem falha do close reabilita leitura de dados não duráveis. Nova instância recupera só o estado efetivamente confirmado. DELETE/EXTRA/fullfsync e timeout de lock de cinco segundos preservados. Não há API de reset, exclusão ou migração. Copiar/retroceder manualmente todo o diretório, host comprometido e falha física de disco ficam fora da garantia.

## Falhas encontradas e correções

- Revisão independente parcial apontou que rejeitar todo `completed_at` posterior ao deadline descartaria evidência de reprovação O6. RED reproduzido; arquivo agora preserva essa observação coerente e o pacote aponta `terminal-row-after-deadline`, sem aprová-la.
- Implementação paralela do store foi interrompida por capacidade do modelo. O principal recuperou os arquivos atuais e completou a quarentena: RED comprovou leitura não durável após falha de COMMIT/ROLLBACK/close; GREEN também cobre COMMIT efetivo com ACK perdido. Não foi alegado envio duplicado.
- A primeira execução focal conjunta reprovou **50/51**: processo concorrente recebeu erro de lock na abertura, antes de o timeout ser instalado. Reprodução controlada com outro processo segurando lock exclusivo falhou; timeout passou a ser instalado antes da inspeção do formato. Não se afrouxou a expectativa de unicidade para aceitar o erro.
- Duas consultas auxiliares da nova fixture de integração usavam colunas inexistentes (`jobs.kind`, `deliveries.id`); corrigidas após ler o schema. Foram erros do teste, não RED funcional nem mudança de schema.
- Na retomada de 14/09, a revisão independente encontrou truncamento de frações de milissegundo por `Date.parse`: uma conclusão SQL `02.500900Z` podia parecer dentro do prazo `02.500100Z`. Três ciclos RED→GREEN corrigiram a comparação de prazo, a cronologia interna e a admissão T2 versus observação T1. A comparação normaliza segundos UTC e preserva a fração decimal completa, inclusive offsets equivalentes e igualdade; não arredonda os timestamps arquivados. `jobDeadlineAtMs` continua sendo representação derivada em milissegundos, não substitui o timestamp exato para esse julgamento.

## Verificação e limites

- Capture/contratos: 13 testes, onze RED→GREEN e duas regressões inicialmente verdes.
- Store: nove testes; três ciclos RED→GREEN relatados pelo autor antes da interrupção, mais dois reproduzidos/corrigidos pelo principal. Demais coberturas não são anunciadas como ciclos RED não observados.
- Pacote de revisão: nove testes, nove RED→GREEN.
- Nova integração usa Engine, PGlite, auditor, SQLite e controller reais locais, mas callback e identidade são sintéticos; snapshot da fixture é legado, não prova financeira v2. Reabertura, memória avançada e revisão não liberam T2; um job/uma reserva fictícia e zero deliveries. Nenhum provedor foi chamado.
- Corrida entre dois processos distintos: somente um artefato vence; o outro conflita. Após confirmação, SIGKILL e reabertura preservam o vencedor. Lock exclusivo em outro processo testa espera de abertura. Não é ensaio de queda elétrica ou garantia de hardware.

Revisão independente final retomada e concluída em 14/09: achado de precisão corrigido; os dois arquivos focais foram executados pelo revisor, **22/22**, sem novo defeito concreto. Aprovação restrita a esta etapa local, não ao envio, publicação ou julgamento humano. Não se contabiliza a revisão anterior interrompida por capacidade como aprovada.

A primeira consolidação da retomada, **510/510 + TypeScript**, foi concluída antes da correção de precisão: `03:03:05.221→03:04:13.616 UTC`, 65.349,578459 ms, manifesto estável e zero falhas/skips/cancelamentos. [TAP pré-correção](SPRINT-04-META-ARTEFATOS-REGRESSAO-20260914T030305221Z.tap) preservado; não é a verificação final da fonte corrigida.

Consolidação corrigida **513/513 + TypeScript**, `03:07:28.897→03:08:42.821 UTC`, 70.795,416292 ms de testes, 77 arquivos de teste, zero falhas/skips/cancelamentos/todo e exit 0. [TAP integral](SPRINT-04-META-ARTEFATOS-REGRESSAO-20260914T030728897Z.tap) e [metadados/manifesto](SPRINT-04-META-ARTEFATOS-REGRESSAO-20260914T030728897Z.json). Manifesto de **167 arquivos**, estável antes/depois da execução e reconferido no disco; em relação à consolidada 481 são nove arquivos novos e somente `tests/sprint4-terminal-audit.test.ts` alterado, nenhum arquivo removido ou `src/*` modificado. O coletor temporário já existente recebeu apenas o rótulo `ARTEFATOS` para não misturar os checkpoints.

Nova [matriz determinística 60/60](SPRINT-04-META-DETERMINISTICA-20260914T030806741Z.json), `03:08:06.741→03:08:27.442 UTC`, manifesto de **80 arquivos** conferido e fonte estável. Foi executada em paralelo com o fim da regressão: a duração não é benchmark comparável de desempenho. Snapshot candidato `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959`, zero violações críticas nas assertivas, rede/modelo/custo zero. Continua sendo execução local com callbacks construídos, sem nota humana, registro remoto ou prova M6.

Identidades SHA-256 dos artefatos finais:

| Artefato | SHA-256 |
| --- | --- |
| Manifesto da regressão, JSON canônico | `fe1985a9ccfa19979fab4b8322d0b29f693dd5cfc0aa49b42d4b7359548a673d` |
| TAP integral | `365f08136173217436ed2bf3017ebd6b8f772947c2b2f79b13b3409f014caacf` |
| Metadados da regressão | `b68f88cfb510ebd933115df72425fca49c32b5e212019c242e4460eaf0236604` |
| JSON determinístico | `d46107b1a810498852a29873417d8b029dc73fc9259d6ece5313422a93a09f65` |
| Manifesto determinístico, JSON canônico | `f3db8e86ee3909147bf485f56bac6e1a5c819be48813161dc6189c4589b6e45a` |

TDD e contratos tipados orientaram as correções reproduzidas, os vínculos cruzados e os resultados explicitamente pendentes. As suítes foram acompanhadas nos mesmos processos até exit 0; nenhum timeout de observação motivou reinício. A revisão final de código não substitui avaliação comercial das respostas.

Conferência independente posterior confirmou os cinco hashes acima, todos os 167/80 arquivos atuais dos manifestos, o diff contra 481 e a coerência do relatório final. O responsável principal verificou também 140 links locais nos cinco documentos de status atualizados, sem destinos ausentes. Nenhum teste/build/deploy ficou em execução ao concluir o checkpoint.

## Próximos gates reais

Ainda faltam composição privada de ambiente/prontidão e vínculo obrigatório de arquivo/avaliações ao recibo; snapshot/fontes/artefatos adicionais e avaliação objetiva aplicável; custo/contexto T2 e viabilidade completa; pacote exato publicado; campanha real 30×2 e média humana; M6; QA autenticada/papéis; validação pessoal de João e aceite comercial de Gabriel. Nenhuma infraestrutura foi contratada. Admin específico e credencial segura continuam dependências próprias, sem inferência por indicação de nome ou login para QA.

API/worker r8 e site v10 continuam últimas publicações documentadas, não equivalem à árvore local. Saldo permanece somente a fotografia de 00:27:41 UTC: 359.814/640.186 microUSD, sem nova leitura nesta etapa. Gate/cota/teto, modelo e canais desativados preservados. **Meta ativa; não concluída.**
