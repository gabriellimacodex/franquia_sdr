# Sprint 3 — Homologação humana e isolamento publicado

## Atualização após QA real — prevalece sobre a baseline histórica abaixo

Ver [bateria de 11/09/2026](SPRINT-03-QA-20260911.md): duas sessões novas, quatro chamadas pagas e duas saudações gratuitas. Interface desktop, teclado, rascunho e respeito à leitura foram demonstrados. Três respostas contextuais levaram 20,380 / 19,146 / 17,758 s E2E; saudação fixa 3,441 s. Falso positivo do guard ao recapitular capital do candidato confirmado por reprodução local. A correção de cidade mantém fato em conflito, mas o texto afirma atualização concluída. Rótulo de sessão também pode permanecer “Continuar” após pausa. **Qualidade, latência e aceite completo seguem pendentes; nenhuma correção dessas falhas foi implantada na QA.**

O usuário autorizou ampliar o limite **total para R$ 10,00 se necessário**, e a insuficiência da reserva conservadora foi comprovada. Overlay vigente: mesmo gate `sprint3-continuous-20260910`, **1.000.000 microUSD (US$ 1,00) TOTAL**, mesma imagem r5, sem reset de consumo ou novo modelo. Treze testes budget/deployment passaram após RED → GREEN; backup do overlay anterior preservado. Às 14:36:18 UTC: 18 reservas liquidadas / zero pendentes, **191.984 usados / 808.016 disponíveis**. Bateria custou 58.159 microUSD. Às 14:36:54 UTC: zero deliveries e zero canais habilitados. Worker/n8n permanecem ativos; WhatsApp/Kapso desativados.

Mobile, sessão real do reviewer e logout/retomada ainda dependem de validação. O usuário passou a discutir evolução com Lovable/Replit; nenhuma importação, novo repositório externo ou migração foi executada.

## Baseline anterior à bateria

Estado em 11/09/2026: **release r5 implantada, worker ativo e frontend v6 publicado; 130/130 testes de backend, TypeScript, 123/123 testes de frontend, build, lint sem erros e 8/8 testes Docker remotos aprovados. O workflow exclusivo está publicado como `Sprint 3 — continuidade de conversa r5`. Última leitura do mesmo gate: dez chamadas pagas e US$ 0,093324, saldo US$ 0,106676.** Nenhuma chamada paga nova foi feita nesta etapa. Melhorias de latência e condução ainda precisam de validação E2E real; rejeições por `POLICY_GUARD`, qualidade, reviewer, logout/retomada e mobile autenticado continuam impedindo o encerramento do sprint.

## Objetivo

Comprovar autenticação real, autorização por papel, isolamento, retomada da sessão persistida e qualidade visual do laboratório publicado. O escopo original proibia reativar worker, publicar n8n ou chamar o modelo; um primeiro gate adicional autorizou uma janela controlada de até cinco mensagens e R$ 2,00, encerrada após a primeira execução aprovada. Depois de Gabriel informar que o chat continuava sem responder fora dessa janela, o usuário autorizou manter worker e n8n ativos em homologação, com acesso exclusivamente de Gabriel (`tester`) e João (`reviewer`), teto adicional de R$ 2,00 e WhatsApp/Kapso desativados. A infraestrutura contínua processou cinco mensagens de teste e demonstrou continuidade, mas duas rejeições por `POLICY_GUARD` e um balão indevido na quarta resposta impedem o aceite funcional. A quinta resposta foi coerente. As regras do guard não foram alteradas sem conhecer a razão exata das rejeições; não há evidência para classificá-las como falsos positivos. Nenhum canal externo foi habilitado.

## Micro-metas

| Micro-meta | Estado | Evidência atual | Risco residual / próximo passo |
| --- | --- | --- | --- |
| S3.01 Baseline e invariantes | r5 local e remota aprovada | R5: 130/130 testes, TypeScript e 8/8 testes remotos no Docker sem rede aprovados; worker ativo. Frontend: 123/123, build aprovado e lint sem erros, com três avisos preexistentes. | Preservar o mesmo gate de orçamento em futuros redeploys. |
| S3.02 Contas e autenticação real | tester aprovado; reviewer pendente | Gabriel e João estão confirmados no Supabase, possuem senha cadastrada, membership ativa e login anterior. O Auth usa a origem publicada e permite exatamente `/laboratorio-sdr` como retorno. O fluxo publicado aceita somente `type=recovery`, remove o fragmento da URL, não persiste a sessão temporária e a revoga após trocar a senha. Uma única solicitação foi enviada a Gabriel, que definiu pessoalmente a nova senha e concluiu o login tester. | A sessão real de João precisa ser validada por João, em contexto separado. |
| S3.03 Matriz de autorização | parcial | Visitante sem token recebe HTTP 401 `AUTHENTICATION_REQUIRED`; papéis HTTP do Supabase não têm `USAGE` no schema `sdr`; RLS de `lab_sessions` está habilitada e forçada. Testes locais cobrem tester negado em endpoints de reviewer e retomada isolada. | Falta comprovar tester/reviewer e logout com tokens reais no frontend/API publicados. Não existe identidade autorizada sem membership disponível para o caso negativo. |
| S3.04 Retomada persistida | aprovada para tester | Gabriel entrou e a interface recuperou `Ana Teste — Sprint 2`, a conversa expirada e a nova sessão processada. O job expirado virou `handoff/PROCESSING_TIMEOUT` com zero tentativas; uma nova mensagem completou na primeira tentativa. | Falta repetir a retomada e o logout com reviewer. |
| S3.05 Visual publicado | v6 de fluidez publicada; QA real pendente | Layout compacto, rolagem própria do chat, caixa acessível, lista recolhida no mobile, Enter envia/Shift+Enter quebra linha, envio otimista, rascunhos por sessão e proteção contra polling antigo. Mantém o polling adaptativo e deadline da v5. | Validar viewport mobile autenticado e percepção humana após uso prolongado; teste no navegador ainda aguarda resposta do usuário. |
| S3.06 Revisão da execução | aceite funcional e comercial pendente | Duas rejeições iniciais por `POLICY_GUARD` continuam sem causa exata disponível. A quarta chamada exibiu `bubbles?`, e a quinta foi coerente. Em chamada posterior do usuário, prefixo `79905ffa`, a instrumentação confirmou `unsupported_commercial_number`: a faixa correta foi reformulada, mas o guard exige a sentença literal da fonte. | Resolver a incompatibilidade entre reformulação e exigência literal, sem atribuir essa causa às duas rejeições antigas; corrigir qualidade e obter revisão comercial humana. A otimização r3 não altera o guard. |
| S3.07 Novas chamadas | infraestrutura e continuidade demonstradas; aceite pendente | O primeiro gate custou US$ 0,011468 ≈ R$ 0,06. O gate `sprint3-continuous-20260910` soma dez chamadas e 93.324 microUSD (US$ 0,093324), incluindo a continuação “São Paulo” do usuário. Cota preservada em 200.000 microUSD; saldo de 106.676 microUSD. Briefings `gpt-5-mini` continuam bloqueados. | Worker e n8n permanecem ativos com consumo limitado pelo mesmo gate; nenhum reset de orçamento. |
| S3.08 Evidências e handoff | em andamento | Este documento registra a baseline sanitizada e os gates pendentes. | Completar a matriz E2E, revalidar estado final e atualizar `implementation-status.md`. |
| S3.09 Latência percebida | r5 implantada; nova medição pendente | R5 elimina dois GETs após o envio usando um snapshot atômico no POST. A r3 mediu 10,879011 s no banco e a saudação fixa r4 mediu 3,765 s E2E; essas medições anteriores não validam a nova conversa completa. | Medir clique até resposta visível, continuidade e qualidade; outro modelo exige autorização. |

## Baseline local

- `sapore-sdr`: `npm run check` da r5 aprovado, com TypeScript e **130/130 testes** passando. A r5 acrescenta cinco testes de snapshot atômico e três de histórico n8n, com evidência RED → GREEN.
- R3 no Docker remoto sem rede: **7/7 testes** aprovados. R4 no Docker remoto sem rede: **9/9 testes** aprovados antes da ativação.
- R5 no Docker remoto sem rede: **8/8 testes** de snapshot e histórico aprovados antes da ativação.
- Suíte de orçamento executada na primeira imagem contínua Docker sem rede: **11/11 testes** passando.
- `borelli-expansao`: build aprovado e **123/123 testes** passando; dez novos testes de fluidez, sem dependências adicionais.
- ESLint: zero erros e três avisos preexistentes (`no-img-element` e dois identificadores não utilizados).
- Fastify mantém o aviso preexistente sobre `disableRequestLogging` antes da futura versão 6.
- O workspace raiz continua sem uma linha de base Git rastreada para `sapore-sdr/`, `borelli-expansao/` e `entregas/`. O commit de publicação foi criado em clone isolado do site, incluindo somente três arquivos da tarefa; alterações preexistentes do workspace foram preservadas.
- Auditoria de produção do frontend encontrou cinco pacotes com vulnerabilidades preexistentes (uma crítica, três altas e uma moderada). Lockfile e dependências não foram alterados; a inspeção de vinext/Workers não demonstrou novo caminho explorável. Tratar a atualização de dependências separadamente, sem `npm audit fix` automático.

## Baseline remota

### Supabase

- Projeto `xxvfuyydhfijhudtytsk`.
- `gabriel.lima@cognitaai.com.br`: confirmado, com login anterior e membership `tester` ativa em `cognita-homologacao/sapore`.
- `joao.lucas@cognitaai.com.br`: confirmado, com login anterior e membership `reviewer` ativa no mesmo escopo.
- Cadastro público: `disable_signup=true`.
- E-mail habilitado; usuários anônimos desabilitados; autoconfirmação desabilitada.
- Configuração de URL do Auth corrigida: `Site URL=https://borelli-expansao.ana-mendes.chatgpt.site` e Redirect URL `https://borelli-expansao.ana-mendes.chatgpt.site/laboratorio-sdr`.
- `lab_sessions`: RLS habilitada e forçada.
- `anon`, `authenticated` e `service_role`: sem `USAGE` no schema privado `sdr`.
- Contagens antes da retomada contínua: quatro sessões de laboratório, zero canais habilitados e zero deliveries. O job que havia expirado nesse intervalo foi encerrado pelo worker sem chamada ao modelo.

### API e VPS

- `https://sdr-api.cognitaai.com.br/health`: HTTP 200, `environment=homologation` e `outboundEnabled=false`.
- `https://sdr-api.cognitaai.com.br/ready`: HTTP 200.
- Última imagem validada antes do modo contínuo: `sapore-sdr:sprint3-20260910-r2`, com API saudável e worker encerrado em `Exited (0)` após o primeiro gate.
- Imagem atual de API e worker: `sapore-sdr:sprint3-fluidity-20260911-r5`, release `/opt/sapore-sdr/releases/20260911T033000Z/sapore-sdr`. `/health` aprovado, `/ready=ready`, worker ativo e `outboundEnabled=false`; oito testes da imagem remota sem rede aprovados. R4 preservada em `/opt/sapore-sdr/releases/20260911T031300Z/sapore-sdr` para rollback.
- SHA-256 do pacote r5 implantado: `14db4b9d222fb22c796fd21393c6dee4dbd5ac189b5734287255d4c09110a715`. Os dois arquivos Compose, a identidade do gate e sua cota foram preservados.
- SHA-256 do pacote r3 implantado: `3b078ee569d0a7a4e7f7d6e63406e107fc436cd38650ec5f3dd151cd0c6e06cb`.
- R4 implantada com SHA-256 do pacote fonte `158c2c6773d53efd31c25506518637edcf77a0e5092d23faa97be410d6143938`. Os dois arquivos temporários de transferência foram removidos da VPS; as releases e cópias locais foram preservadas.
- A release r2 acrescenta diagnóstico do guard: eventos contêm somente os códigos de violação; os balões rejeitados ficam no contexto privado do job de laboratório, sem exposição ao tester. As regras de validação não foram alteradas.
- Preflight aprovado: execução em laboratório, conexão TLS, retenção automática desabilitada e `outboundEnabled=false`.
- No novo modo autorizado, o worker permanece em execução após os testes, sujeito à cota persistida do gate.
- Checagem remota ao concluir a etapa r2: API saudável, worker `Up`, `/ready=ready`, execução em laboratório, `CHANNEL_ENABLED=false`, `RETENTION_ENABLED=false`, cota do gate de 200.000 microUSD e zero deliveries. A bateria dessa etapa terminou em cinco testes; três chamadas posteriores dos usuários estão incluídas no saldo atualizado antes da r3.
- Containers do CRM continuam em execução; nenhum serviço foi reiniciado ou alterado.

### n8n

- Histórico do primeiro gate: workflow `SaporeAsyncV1Lab` / `Sapore SDR — async reasoning v1` publicado temporariamente para uma execução e despublicado em seguida. Seus cinco nós e os três workflows preexistentes foram preservados.
- Modo contínuo: workflow `SaporeAsyncV1Lab` em `https://sdr-n8n.cognitaai.com.br` publicado como `Sprint 3 — continuidade de conversa r5`, sucedendo `Sprint 3 — contínuo com tarifa padrão`. A chamada mantém modelo autorizado, `service_tier=default`, `store=false` e limite de saída de 1.200 tokens. Apenas o nó `Validate and prepare job` mudou nesta etapa; credenciais, callback, schema, snapshot e outros workflows foram preservados. O workflow permanece publicado para a homologação autorizada.
- As opções de retenção são `saveDataSuccessExecution=none`, `saveExecutionProgress=false` e `saveManualExecutions=false`; a ausência de uma linha de sucesso no histórico n8n não substitui a verificação dos jobs, uso e eventos persistidos na aplicação.
- Antes da nova publicação, uma requisição **HEAD** ao webhook despublicado retornou HTTP 404 sem executar POST ou disparar o modelo. Essa é uma evidência histórica, não o estado do workflow publicado para o modo contínuo.

## Sessão persistida — baseline anterior aos novos testes

- Rótulo: `Ana Teste — Sprint 2`.
- Conversation ID: `2e32025d-1af8-4e4b-b8bf-45cccc365951`.
- Owner: Gabriel (`tester`).
- Estado da conversa: `automatic`.
- Histórico: uma mensagem candidata e duas mensagens do agente.
- Job: concluído na primeira tentativa, sem erro, 1.884 tokens de entrada, 463 de saída, 2.347 totais, zero reasoning tokens e 19.059 ms.
- Memória: três fatos declarados (`name`, `city`, `motivation`), todos ligados a citações da mensagem candidata.
- Evidência operacional: um evento `turn_completed`, zero deliveries.

## Revisão técnica da resposta existente

### Aprovado

- Abertura clara, personalizada e compatível com um atendimento inicial.
- Faixa de investimento apresentada exatamente como na fonte aprovada: R$ 250 mil a R$ 280 mil.
- A composição entre giro, taxa e implantação foi corretamente mantida como pendente de validação.
- Não houve alegação sobre royalties, margem, faturamento, retorno ou disponibilidade territorial.
- A pergunta sobre operar diretamente ou com gestor é um próximo passo pertinente para qualificação.
- Nome, cidade e motivação foram extraídos como declarações, não como fatos externamente confirmados.

### Ressalvas

- A resposta se divide em duas bolhas apesar de formar uma única unidade semântica; a decisão pode ser válida para WhatsApp, mas deve ser julgada pelo reviewer quanto à naturalidade no navegador.
- O primeiro contato não esclarece que a faixa é apenas uma referência de homologação. A incerteza sobre a composição reduz o risco, porém a redação comercial final ainda merece aprovação humana.
- Uma execução não comprova consistência nos outros 14 cenários.

## Gastos e no-send

- Chamadas concluídas e registradas no primeiro gate deste sprint: **1**, de até cinco então autorizadas. As medições do gate contínuo aparecem separadamente abaixo.
- Modelo: `gpt-5.4-2026-03-05`.
- Uso: 1.881 tokens de entrada, 451 de saída, 2.332 totais e zero reasoning.
- Custo estimado: **US$ 0,011468 ≈ R$ 0,06**, abaixo do teto de R$ 2,00.
- Briefings `gpt-5-mini`: **0 chamadas**; bloqueados por código no canal de laboratório.
- Novos deliveries: **0**.
- Canais habilitados: **0**.
- O primeiro gate terminou com worker parado e workflow despublicado. Essa regra foi substituída pela autorização explícita do modo contínuo: worker e workflow permanecem ativos para o laboratório. WhatsApp e Kapso seguem desativados.

### Controle do novo gate contínuo

- Gate: `sprint3-continuous-20260910`, adicional ao primeiro gate e sem reutilizar seu teto.
- Handoff de redeploy: toda implantação de API/worker deve incluir `compose.lab-budget.yaml` e preservar `LAB_BUDGET_GATE_ID=sprint3-continuous-20260910` e a cota vigente de **1.000.000 microUSD**. Não trocar nem reiniciar o gate para liberar saldo sem nova autorização de orçamento. A cota anterior de 200.000 abaixo é histórica e não deve ser restaurada em novo deploy.
- Autorização inicial: teto adicional de **R$ 2,00**; cota operacional inicial de **200.000 microUSD (US$ 0,20)**. Substituída durante a QA pela autorização de teto **TOTAL R$ 10,00**, aplicada conservadoramente como **US$ 1,00 no mesmo gate**, com gasto anterior preservado.
- Modelo mantido: `gpt-5.4-2026-03-05`, tarifa padrão (`service_tier=default`) e saída limitada a **1.200 tokens**.
- Reservas de custo registradas em eventos persistidos, sobrevivendo à reinicialização do worker.
- Uso desconhecido e chamadas com retentativas conservam a reserva máxima. Somente conclusão aceita em tentativa única permite acertar a reserva pelo uso efetivo.
- Acesso preservado para Gabriel (`tester`) e João (`reviewer`), sem ampliar as permissões de cada papel.
- Testes técnicos e implantação aprovados. As chamadas 4 e 5 demonstraram continuidade, porém as duas rejeições anteriores por `POLICY_GUARD` e a falha de qualidade da chamada 4 impedem o aceite funcional.
- O job `lab-af971d69ef4427ea93b505cabe78dc63:afb4a9b5-7420-481e-a219-f4f76f8b9472`, criado em `2026-09-10T23:32:57Z`, terminou em `handoff/PROCESSING_TIMEOUT`, com zero tentativas, em `2026-09-11T02:25:20.9676Z`; não chamou o modelo.
- Primeiro teste contínuo: job `lab-af971d69ef4427ea93b505cabe78dc63:8bbc4b6d-4bea-455b-8fbd-ef17037a0b1b`; duração **18,568 s**; uso de **2.780 tokens de entrada + 261 de saída = 3.041 tokens**. Reserva inicial de **57.803 microUSD**, custo efetivo de **10.865 microUSD (US$ 0,010865)** e `settled=true`.
- Resultado desse turno: `handoff/POLICY_GUARD`; resposta determinística visível iniciada por “Esse ponto precisa de revisão da equipe...”. A saída bruta rejeitada não está disponível, portanto a causa comercial exata ainda não foi confirmada.
- Segundo teste contínuo: nova conversa de Bruno/Sorocaba, ID `843a1717-1903-4611-a526-b8ce5e695978`, job `lab-af971d69ef4427ea93b505cabe78dc63:a6a50a5e-79a1-4fea-982f-ede710df0ba5`. Concluído na primeira tentativa, sem erro, em **18,116 s**; **1.881 tokens de entrada + 455 de saída = 2.336 tokens**, zero reasoning. Custo acertado de **11.528 microUSD**, arredondado para cima. A resposta cumprimentou Bruno, apresentou a faixa de R$ 250 mil a R$ 280 mil e perguntou sobre operar diretamente ou ter gestor.
- Terceiro teste contínuo: continuação na mesma conversa de Bruno, job `lab-af971d69ef4427ea93b505cabe78dc63:53344687-039c-433d-ad0c-9703117adf04`. Duração de **16,707 s**; **2.774 tokens de entrada + 340 de saída = 3.114 tokens**, zero reasoning; custo de **12.035 microUSD**. Terminou novamente em `handoff/POLICY_GUARD`.
- Quarto teste contínuo: sessão `Ana Teste — Sprint 2`, job `lab-af971d69ef4427ea93b505cabe78dc63:6b927e23-05a3-4cb4-be4c-d55415002fb3`. Concluído em **16,910 s**; **2.794 tokens de entrada + 284 de saída = 3.078 tokens**; custo de **11.245 microUSD**. Passou pelo guard, mas exibiu um balão indevido `bubbles?`: qualidade reprovada para esse turno.
- Quinto teste contínuo: continuação na mesma sessão Ana, job `lab-af971d69ef4427ea93b505cabe78dc63:3648067d-74f8-4702-a1da-54d90376e127`. Concluído em **16,864 s**; **3.438 tokens de entrada + 342 de saída = 3.780 tokens**; custo de **13.725 microUSD**. A resposta foi coerente, apresentou o investimento aprovado e perguntou sobre o decisor.
- Consumo dos cinco testes iniciais: **59.398 microUSD (US$ 0,059398)**. Todos usaram uma tentativa e têm `settled=true`. Essa bateria foi encerrada, mantendo a operação autorizada para os usuários.
- Atualização anterior à validação de latência r3: mais três chamadas dos usuários elevaram o gate para **oito chamadas e 79.646 microUSD (US$ 0,079646)**. Saldo de **120.354 microUSD (US$ 0,120354)**, com identidade do gate e cota de 200.000 microUSD preservadas.
- Validação r3: job `lab-af971d69ef4427ea93b505cabe78dc63:5d6d1ece-0a5d-4dfb-afd1-32ac24751812`, sessão com prefixo `454090`, mensagem `oi`. Concluído sem erro, com **1.856 tokens de entrada + 74 de saída = 1.930 tokens**, zero reasoning, custo de **5.750 microUSD**. Gate atualizado para **nove chamadas, 85.396 microUSD (US$ 0,085396)** e saldo de **114.604 microUSD (US$ 0,114604)**.
- A instrumentação r2 registra apenas os códigos das violações nos eventos e preserva os balões rejeitados no contexto privado do job de laboratório, não exposto ao tester. As duas rejeições anteriores ocorreram antes dessa instrumentação e suas saídas brutas permanecem indisponíveis. O guard não foi flexibilizado e as rejeições não foram classificadas como falsos positivos.
- Em um terceiro caso de guard, posterior à instrumentação, o job do usuário com prefixo `79905ffa` tem razão confirmada: `unsupported_commercial_number`. O balão dizia “Perfeito, São Paulo. Hoje a referência de investimento da Sapore Açaí é de R$ 250 mil a R$ 280 mil.” O guard exige a reprodução literal “O investimento de referência para a Sapore Açaí é de R$ 250 mil a R$ 280 mil.” Nesse caso, a rejeição decorre da reformulação da referência, não de valores divergentes. A chamada também fazia a pergunta sobre operar diretamente ou ter gestor. Essa evidência não confirma a causa das duas rejeições antigas; a otimização de latência mantém as regras atuais do guard.
- Resultado parcial: infraestrutura e continuidade demonstradas; qualidade e causas das rejeições ainda impedem o aceite funcional e o encerramento do sprint.

## Otimização de latência

Gabriel relatou demora de aproximadamente 15 s para a resposta. O diagnóstico mediu RTT remoto de cerca de **148 ms** e uma consulta `SELECT 1` dentro do escopo original entre **734 ms e 1.610 ms**, sob contenção. Esse resultado motivou reduzir viagens sucessivas ao banco, preservando as restrições transacionais e de acesso.

- Baseline da mensagem `oi`, sessão com prefixo `583930`, job `233f6cc3-78f7-4649-84ab-21353b22da67`: duração registrada de **14,8226 s**, composta por **3,5518 s** de fila, **4,5519 s** de preparação e **6,7189 s** nas demais etapas. Na sessão com prefixo `ddd128`, o job `36bedee3-787e-46e0-b67a-3ba53623d1df` registrou **14,208443 s**.
- Esses tempos derivam de registros de banco. `now()` marca o início da transação e não inclui o commit; portanto, **não são medições E2E do navegador**, nem isolam sozinhos a duração do modelo.
- O engine evita a consulta de embeddings no laboratório, a conclusão reaproveita a leitura já feita e áudio/última mensagem são buscados no mesmo escopo. A resolução de canais usa uma consulta, e o preparo de escopo consolida configurações em um `SELECT`, preservando locks e configurações transacionais.
- `LabSessions.detail` usa uma consulta com validação do proprietário e preservação dos dados privados. A criação de jobs do laboratório usa `available_at=now()` sem o debounce de 2 s; o debounce de **2 s no WhatsApp permanece inalterado**.
- Modelo `gpt-5.4-2026-03-05`, prompt, workflow n8n, regras do guard, identidade do gate e teto foram preservados. A versão 5 do frontend não mudou.
- R3 implantada com **120/120 testes locais e TypeScript aprovados**, além de **7/7 testes no Docker remoto sem rede**. O escopo remoto preservou tenant e marca; medições de **1.018 ms, 587 ms e 587 ms**, sob contenção, comparadas ao melhor valor anterior de 734 ms.
- Na validação r3, o job `5d6d1ece-0a5d-4dfb-afd1-32ac24751812` registrou **10,879011 s**: **0,741632 s** de fila, **3,819062 s** de preparo e **6,318317 s** nas demais etapas. É uma amostra aproximadamente **26,6% menor** que a baseline de 14,8226 s; não comprova uma distribuição de latências nem garante esse tempo no navegador.
- A resposta estava visível na observação feita até **15,086 s** após o clique. Houve timeout de 3 s na primeira observação e uma segunda checagem posterior, portanto esse registro não mede precisamente quando a resposta apareceu. **Não houve medição E2E precisa; 10,879011 s é duração registrada no banco, não tempo visível.**
- R4 implantada: resposta determinística fixa somente para o primeiro `oi`/`olá` isolado em sessão sem histórico, com memória inicial, tenant/marca do piloto e canal laboratório. Mensagens mistas, perguntas, informações e continuações preservam o fluxo pelo modelo, os controles e o guard. **122/122 testes, TypeScript e 9/9 testes Docker remotos sem rede aprovados**. Revisão independente confirmou dono, idempotência, histórico no próximo turno, exclusão por memória anterior e ausência de reserva de orçamento.
- Validação gratuita r4: sessão `dcfdb8`, job `lab-af971d69ef4427ea93b505cabe78dc63:2a503636-085d-401b-814f-059acbb5e77b`, registrou **1,313523 s no banco**. O E2E dessa primeira observação não foi preciso.
- Segunda validação gratuita r4: sessão `8a9732`, job `lab-af971d69ef4427ea93b505cabe78dc63:da83bfb5-d2f4-448e-947f-d504095b1fc4`, registrou **1,668325 s no banco** (03:13:23.615469Z a 03:13:25.283794Z) e **3,765 s do clique em Enviar até a resposta visível no navegador**, medidos na mesma execução. Ambos os jobs ficaram `completed`, com `attempts=0` e origem privada `deterministic_greeting`.
- Após os dois testes gratuitos, o gate permaneceu em **nove chamadas pagas, 85.396 microUSD consumidos e 114.604 microUSD de saldo**. Zero deliveries e canais desabilitados. O teste `8a9732` ficou aberto no navegador. Essa única medição E2E é da abertura fixa, não da geração pelo GPT nem uma garantia para toda a conversa. Nenhum modelo alternativo foi autorizado ou alterado; qualidade e latência das respostas completas continuam pendentes.

## Fluidez de interface e continuidade — r5

Gabriel respondeu que os três pontos incomodam: demora, condução e espaço/rolagem. O caso de referência é a sessão `7f92037f-6ca5-4d26-b178-80da83cede36`:

- `oi`, job `lab-af971d69ef4427ea93b505cabe78dc63:d312a60a-0049-46c9-8a3c-33b64d95f43b`: saudação determinística, zero tentativas, duração de banco 1,250711 s.
- `São Paulo`, job `lab-af971d69ef4427ea93b505cabe78dc63:ee2ef26a-7ef5-43fc-9222-aef65f82001c`: 03:19:56.100819Z → 03:20:07.013567Z, **10,912748 s no banco**, tentativa única, sem erro, 2.037 tokens de entrada e 189 de saída, custo de **7.928 microUSD**. A resposta repetiu a apresentação e perguntou sobre operar diretamente ou ter gestor. Não é medição E2E do navegador.
- O contexto já continha `oi`, saudação e `São Paulo`. O adaptador, porém, entregava todo o JSON como uma só mensagem de usuário; isso é uma hipótese para a repetição, não causa confirmada.

### Mudanças e invariantes

- API: POST de mensagem retorna `jobId` e `detail` no mesmo escopo e transação. Cobre envio normal, saudação, controle e replay; snapshot falho reverte a transação. Replay conserva o ID original e informa o job atual dentro de `detail`. Autenticação e propriedade continuam verificadas.
- Frontend: aproveita esse snapshot sem GET de lista nem GET de detalhe após o envio. O fallback para API anterior consulta somente a própria sessão. As consultas em voo são canceladas e respostas antigas não substituem a conversa atual. Não há cache de autorização.
- Envio otimista mostra somente o texto real do candidato, como “Enviando…”. Falha conserva rascunho e chave idempotente; histórico persistido não é duplicado numa repetição. Rascunhos são separados por sessão, foco volta ao campo e Enter/Shift+Enter respeitam composição IME.
- Layout: balões e espaçamentos menores, rolagem limitada ao chat, campo acessível, lista escondida no mobile durante conversa. Novas respostas seguem o fim apenas quando o leitor está perto dele; caso contrário aparece o botão de novas mensagens. CSS restrito ao workspace tester; auth e reviewer não foram redesenhados.
- n8n: somente conversas `lab-` usam entrada de metadados sem histórico seguida das mensagens com papéis nativos. IDs, textos e evidências permanecem serializados em cada mensagem. Histórico máximo de 24 mensagens, papéis validados; entrada malformada é recusada e texto candidato não ganha autoridade de sistema. WhatsApp/briefing e limites de bytes permanecem preservados.
- Essa representação segue o padrão documentado de [estado de conversa da Responses API](https://developers.openai.com/api/docs/guides/conversation-state). Não altera o snapshot de negócio `sapore-v1-a1a330f07cd0`, modelo, esquema de resposta, guard, orçamento, credenciais ou audiência. Nenhuma mensagem foi enviada por canal externo.

### Publicação e evidências

- Frontend **v6**, commit integral `7f1917788857688ee21f1f5ee81f56643a5a53e2`; somente três arquivos foram enviados a partir de clone isolado da v5. Lockfile intacto; build e 123 testes passaram, lint sem erros e com três avisos anteriores.
- Version ID `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_a04b9bbd4e008191a87234ff2b33f174`; deployment `appgdep_6aa3771126708191a124fbe8bcf87b5d`, **succeeded** em 11/09/2026 às 03:36:14 UTC. URL: `https://borelli-expansao.ana-mendes.chatgpt.site`. A audiência custom existente foi preservada.
- API r5: 130 testes e TypeScript aprovados; imagem remota: oito testes isolados de snapshot/histórico aprovados sem rede. N8n publicado como `Sprint 3 — continuidade de conversa r5`; nenhum botão de execução manual foi acionado.
- Checagem final somente leitura às 03:37:17 UTC: API `running healthy`, `/health=ok`, `/ready=ready`, worker `running`. Ambos r5, `EXECUTION_MODE=laboratory`, canal/retention/native-control false; gate e cap preservados.
- Supabase às 03:37:00.293987 UTC: dez reservas liquidadas, zero pendentes, **93.324 microUSD usados / 106.676 disponíveis**. Às 03:37:03.435254 UTC: zero deliveries e zero dos dois canais habilitados no escopo do piloto.
- **Nenhuma nova chamada paga nesta etapa.** O teste fictício no navegador foi proposto e ainda aguarda resposta do usuário; portanto não houve QA visual real nem nova medição E2E da r5. Testes automatizados não comprovam naturalidade. As falhas comerciais anteriores, reviewer, logout/retomada e mobile autenticado continuam pendentes. Não declarar o sprint concluído.

## Recuperação de senha e gate atual

O erro apresentado por Gabriel foi reproduzido no login real. Como a conta está confirmada, possui senha e membership `tester` ativa, a falha ocorreu na autenticação por senha antes da verificação de autorização da aplicação. O frontend publicado agora possui as etapas **Esqueci minha senha**, **Enviar link de recuperação** e **Definir nova senha**.

Com autorização explícita, a Site URL e a Redirect URL foram corrigidas, a versão 4 foi publicada a partir do commit `096b6192e43c682c540306b9f8da67cf9804ede1` e uma única recuperação foi solicitada para `gabriel.lima@cognitaai.com.br`. O registro `recovery_sent_at` confirma a aceitação da solicitação pelo Supabase. Gabriel definiu pessoalmente a nova senha e concluiu o login tester. A validação de João, o logout e a retomada posterior ainda precisam ocorrer em sessões humanas separadas. Nenhuma credencial foi capturada ou reutilizada e nenhuma tentativa automática de login foi feita.

## Diagnóstico após o primeiro login

- Login de Gabriel aprovado e sessão persistida no navegador.
- Nova sessão `Conversa livre` criada às 20:09 BRT; a mensagem `oi` foi salva.
- Job `lab-af971d69ef4427ea93b505cabe78dc63:133c91ee-7da0-408c-80d3-d9a4c6572586` foi encerrado como `handoff/PROCESSING_TIMEOUT`, com zero tentativas e sem chamada paga.
- Nova sessão `Investimento e dúvidas`, ID `170ba6a6-50e9-46f6-879c-cbbc30c7eade`, completou o job `lab-af971d69ef4427ea93b505cabe78dc63:dfed211d-8596-49d7-bf25-5f2e119fe64a` na primeira tentativa.
- A resposta foi exibida no frontend, preservou a faixa aprovada de R$ 250 mil a R$ 280 mil e manteve a composição como pendente de validação.
- Nome, cidade e capital disponível foram persistidos como declarações com citações exatas da mensagem fictícia; um evento foi registrado e nenhum delivery foi criado.
- Ao encerrar o primeiro gate, worker `sapore-sdr-worker-1` voltou a `Exited (0)`, a API permaneceu saudável com `outboundEnabled=false` e o workflow n8n ficou despublicado. A autorização posterior substituiu esse encerramento: o modo contínuo está implantado com API saudável, worker ativo e n8n publicado.
- A versão 5 corrigiu a carga excessiva: consulta a cada 2,5 s somente durante processamento válido, recua para 15 s quando ocioso/expirado e para 30 s em aba oculta, além de encerrar visualmente jobs vencidos.
