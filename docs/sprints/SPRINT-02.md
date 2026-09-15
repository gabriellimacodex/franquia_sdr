# Sprint 2 — Agente real no laboratório Sapore

Estado em 10/09/2026: **gate remoto executado; uma chamada real concluída dentro do teto, worker parado e workflow despublicado**.

## Objetivo

Entregar o laboratório autenticado de homologação em que usuários autorizados conversem com o agente Sapore por sessões persistentes, com isolamento por organização, marca e testador, sem WhatsApp, candidatos reais ou alterações em outros serviços.

Fluxo-alvo:

`frontend → API → PostgreSQL/Supabase → fila → worker → n8n → modelo → resposta estruturada → persistência → frontend`

## Gate obrigatório de entrada

| Verificação | Estado | Evidência |
| --- | --- | --- |
| `sdr.lab_sessions` existe | aprovado | Catálogo remoto consultado em 10/09. |
| RLS habilitada e forçada | aprovado | `relrowsecurity=true` e `relforcerowsecurity=true`. |
| `003_lab_sessions` registrada uma vez | aprovado | Ledger do produto contém uma linha, aplicada em `2026-09-10T19:53:28.483029Z`; histórico Supabase contém `20260910195328_sapore_sdr_003_lab_sessions`. |
| `sdr_runtime` tem somente CRUD em `lab_sessions` | aprovado | SELECT/INSERT/UPDATE/DELETE=true; TRUNCATE/REFERENCES/TRIGGER=false; USAGE=true e CREATE=false no schema. |
| Papéis da Data API sem acesso direto a `sdr` | aprovado | `anon`, `authenticated` e `service_role` sem USAGE e sem CRUD na tabela. |
| Runner pode ser repetido | aprovado localmente | Suíte cobre duas execuções sem reaplicar DDL; ledger remoto tem uma única versão. Nenhuma nova repetição administrativa foi feita neste incremento. |
| Cadastro público desabilitado | **aprovado** | Controle salvo no painel; `/auth/v1/settings` confirmou `disable_signup=true`, e-mail habilitado e usuários anônimos desabilitados. |
| Memberships explícitas autorizadas | **aprovado** | Gabriel=`tester` e João=`reviewer`, ambos ativos em `cognita-homologacao/sapore`. |
| Login, logout, negação e isolamento reais | pendente | Contas e ambiente estão publicados; falta concluir a matriz com as duas pessoas após a confirmação dos convites. |
| WhatsApp desabilitado | aprovado | Zero canais habilitados; `EXECUTION_MODE=laboratory` rejeita flags WhatsApp no código. |

O frontend e a API estão publicados dentro da audiência autorizada. O workflow foi publicado somente durante a chamada aprovada e voltou a ficar inativo; o worker foi encerrado após o callback.

## Micro-metas

| Micro-meta | Estado | Resultado atual |
| --- | --- | --- |
| S2.01 Baseline e prontidão | concluída | Backend 98/98; frontend 108/108; lint sem erros; segredos locais ignorados pelo Git; auditoria remota atualizada. |
| S2.02 Release/imagem | concluída e preparada na VPS | Imagem `sapore-sdr:sprint2-20260910`, base Node fixada por digest, usuário `node`; 96/96 testes em container Linux/amd64 isolado. A imagem não contém segredos e agora executa somente o serviço de API autorizado. |
| S2.03 API isolada na VPS | concluída | API ativa em `https://sdr-api.cognitaai.com.br`; health/ready HTTP 200, modo laboratório, TLS estrito, outbound e retenção desligados. Worker parado; CRM preservado. |
| S2.04 Frontend autenticado | publicada, E2E humano pendente | Versão 3 implantada com revisão de ambiente 1 e acesso `custom` somente para Gabriel e João. Build e 108/108 testes passaram; falta a matriz real de login/isolamento. |
| S2.05 Workflow n8n exclusivo | concluída e novamente inativa | O owner recuperou o acesso; os 3 workflows preexistentes foram preservados. O novo `SaporeAsyncV1Lab` tem cinco nós, referências verificadas, limite de 1.200 tokens de saída e aceita o prefixo isolado `lab-`; foi despublicado depois da execução. |
| S2.06 Primeira chamada paga | concluída | Uma chamada ao `gpt-5.4-2026-03-05` completou em 19.059 ms, com 1.884 tokens de entrada, 463 de saída e zero reasoning tokens. Custo estimado: US$ 0,011655 ≈ R$ 0,06, abaixo do teto de R$ 2,00. |
| S2.07 Worker do laboratório | execução controlada concluída; parado | O worker processou exatamente um job de laboratório e foi encerrado com código 0 após o callback. O canal WhatsApp permaneceu desabilitado. |
| S2.08 Sessões persistentes | pronto localmente, E2E remoto pendente | Sessões têm owner, candidato independente, versão fixa e listagem para retomada. Teste dedicado reinicia a API, troca o token do mesmo usuário e recupera a mesma sessão e histórico. Isolamento entre dois testadores passa em banco efêmero. |
| S2.09 Memória e fontes | primeira medição real concluída | A execução real recuperou somente `sapore-investimento-homologacao-v1`, citou a faixa aprovada de R$ 250 mil a R$ 280 mil e preservou como incerta a composição de giro, taxa e implantação. |
| S2.10 Briefing e humano | pronto localmente, E2E remoto pendente | Pedido humano pausa a conversa, invalida respostas pendentes, cria briefing e mantém `assignment_status=not_applicable`. Uma tentativa posterior retorna `SESSION_PAUSED` sem alterar mensagens, jobs, briefing, eventos ou deliveries. |
| S2.11 Observabilidade | primeira evidência real concluída | O job real persistiu modelo, tentativa, latência, tokens e estado final sem erro. Foram observados um job, uma execução n8n, três fatos, uma mensagem candidata, duas mensagens do agente, um evento e zero deliveries. |
| S2.12 Cenários de aceite | matriz concluída; 1 de 15 medido | Matriz fechada de 15 casos fictícios/no-send segue a ordem aprovada. Há 98 testes backend e 108 frontend; o primeiro contato/cidade foi medido contra o modelo real. Os demais 14 cenários exigem autorização e orçamento separados. |

## Evidência técnica deste incremento

### Backend

- `npm run check`: TypeScript aprovado e 98/98 testes aprovados após dois ciclos TDD: aceite de IDs `lab-<md5>:<uuid>` no n8n e limite explícito `max_output_tokens=1200`.
- Imagem final local: `sapore-sdr:sprint2-fabc5f421d1a`.
- Hash do pacote de código e avaliação: `fabc5f421d1a3941b5d9a04fb1723089449c1605d70094f2bcf09c7706bbdd76`.
- ID local da imagem: `sha256:cdeb139c9015ecb640c1bf3b13b18d1f206eaeb1e6f8191836d8283f04b277f5`.
- Plataforma local validada: `linux/arm64`; usuário: `node`.
- Base fixada: `node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`.
- Teste da imagem final: rede `none`, filesystem somente leitura, `/tmp` temporário, 2 CPUs, 1 GiB, 128 processos, nenhum arquivo de ambiente ou credencial; 96/96 aprovados.
- O hash foi calculado sobre Dockerfile, manifests, TypeScript, compose, migrações, integrações, scripts, avaliações e testes, com lista de arquivos em ordem lexical e SHA-256 por arquivo antes do digest final.
- A primeira tentativa da imagem anterior falhou apenas porque `tests`, `evaluations` e `compose.yaml`, excluídos da imagem de produção, não estavam todos montados. As repetições com esses artefatos somente leitura aprovaram 84/84, 86/86, 88/88, 91/91, 93/93, 94/94 e, após o bloqueio explícito de chaves Supabase privadas, 96/96.
- `npm run preflight:sprint2` foi aprovado localmente e dentro da imagem final com configuração fictícia segura; recusou `DATABASE_SSL=false` com código de saída 1. O relatório não contém `DATABASE_URL`, chaves, tokens ou o caminho do webhook.
- Imagem reconstruída na VPS: `sapore-sdr:sprint2-20260910`, ID `sha256:8d48730db5a57431707b91b692e0bacc103e12346a0c3d5b421e59a54be592c8`, `linux/amd64`, usuário `node`.
- Pacote remoto: `/opt/sapore-sdr/releases/20260910T212500Z/source.tar.gz`, SHA-256 `edf917e92e3f68321a0168e32862ec141fcc89ab2b2c1dd90ae0720b75f1b0f0`. A imagem passou 96/96 testes e preflight seguro na própria VPS. Somente a API foi iniciada; o worker permanece parado.

### Frontend

- Build e 108/108 testes aprovados após os ajustes.
- ESLint: zero erros e três avisos preexistentes não bloqueantes.
- Fonte publicada somente no repositório privado do Site: commit `d986e2e807513d201b899e2e8dfcfbae98e5916e`; artefato salvo como versão 3 (`sha256:76be0ff6a394dde8281a2d769897f802a59c0efce941ff450bfff5d05be1129a`) e implantado com sucesso em `https://borelli-expansao.ana-mendes.chatgpt.site`.
- Ajustes removem atualizações síncronas de estado dentro de effects, usam `Link` para navegação interna e eliminam atribuição ao identificador reservado `module` nos testes.
- Verificação visual local da rota `/laboratorio-sdr`: HTTP 200 em 1440×900 e 390×844, título e controles visíveis e nenhuma rolagem horizontal. Sem as variáveis de homologação, a página mostrou corretamente o estado “Aguardando conexão do ambiente”; o workspace autenticado continua pendente do gate remoto.
- Uma fixture HTTP estritamente local, com token e dados fictícios, permitiu verificar o workspace autenticado sem tocar Supabase, n8n, modelo ou qualquer serviço externo. Nos modos testador e revisor, em 1440×900 e 390×844, lista, histórico, composer, dossiê, escopo, tokens, latência e logout permaneceram legíveis e sem rolagem horizontal.
- O fluxo local de sair e entrar novamente voltou a listar a mesma sessão fictícia. Essa prova valida a integração e a responsividade da interface contra o contrato simulado; **não** comprova persistência, autenticação ou E2E no ambiente remoto.
- O Chrome usado no teste injetou atributos de uma extensão e produziu um aviso de hidratação no modo desenvolvimento. A diferença registrada aponta exclusivamente para esses atributos injetados; não houve overflow ou quebra dos controles da página.

### Banco remoto

- Projeto `xxvfuyydhfijhudtytsk` saudável em PostgreSQL `17.6.1.166`, revalidado em `2026-09-10T21:13:34Z` somente por leitura.
- `lab_sessions`: uma sessão fictícia de auditoria, propriedade do tester Gabriel e isolada pela política `lab_sessions_scope`.
- Memberships: duas ativas em `cognita-homologacao/sapore`: Gabriel=`tester`, João=`reviewer`.
- Usuários Supabase Auth: dois convidados; Gabriel confirmado e João aguardando confirmação na última leitura. Cadastro público desabilitado e revalidado.
- Canais habilitados: zero.
- Execução fictícia `Ana Teste — Sprint 2`: um job concluído na primeira tentativa, três fatos baseados em evidência, uma mensagem candidata, duas mensagens do agente e um evento.
- Deliveries: zero; canais habilitados: zero; migração 003: uma ocorrência; `sdr_runtime`: somente CRUD na tabela, sem `CREATE` no schema; papéis HTTP: sem `USAGE` no schema.

## Segurança, custos e no-send

- Foi realizada exatamente uma chamada ao modelo pelo workflow n8n exclusivo. Nenhuma chamada Kapso/WhatsApp ou mensagem de canal foi feita.
- Uso: 1.884 tokens de entrada, 463 de saída, 2.347 totais e zero reasoning tokens. Pelos preços oficiais de US$ 2,50/M entrada e US$ 15/M saída, o custo estimado é **US$ 0,011655**; usando PTAX de venda de R$ 5,1149 por US$ em 10/09/2026, aproximadamente **R$ 0,06**, ou 2,98% do teto de R$ 2,00. Impostos e arredondamentos da fatura não estão incluídos.
- Foram enviados somente os convites administrativos autorizados. Nenhuma mensagem a candidato real ou canal operacional foi enviada.
- Nenhuma chave secreta foi adicionada ao repositório ou exposta no frontend.
- Arquivos `.env*` e `.local/` permanecem ignorados.
- Nenhum serviço existente da VPS foi reiniciado. O Caddy recebeu somente um vhost separado após backup e validação; o CRM preservou o mesmo status HTTP antes e depois.
- O advisor do Supabase mantém achados preexistentes, incluindo quatro tabelas privadas sem RLS, função `public.rls_auto_enable()` executável por papel HTTP, função sem `search_path` fixo, chaves estrangeiras sem índice e políticas antigas com init plan. Consulta explícita confirmou que `anon`, `authenticated` e `service_role` não têm SELECT/INSERT/UPDATE/DELETE nas quatro tabelas nem `USAGE` no schema; ainda assim, a ausência de RLS permanece um risco de defesa em profundidade caso grants ou exposição mudem. A nova `lab_sessions` não recebeu alerta de RLS; sua FK para versões ainda não tem índice.

## Arquivos alterados neste incremento

- `sapore-sdr/Dockerfile`
- `sapore-sdr/package.json`
- `sapore-sdr/src/config.ts`
- `sapore-sdr/src/lab.ts`
- `sapore-sdr/src/lab-sessions.ts`
- `sapore-sdr/src/preflight.ts`
- `sapore-sdr/src/store.ts`
- `sapore-sdr/scripts/preflight-sprint2.ts`
- `sapore-sdr/evaluations/sprint-02-acceptance.ts`
- `sapore-sdr/tests/lab-sessions.test.ts`
- `sapore-sdr/tests/knowledge.test.ts`
- `sapore-sdr/tests/lab-config.test.ts`
- `sapore-sdr/tests/preflight.test.ts`
- `sapore-sdr/tests/sprint2-acceptance.test.ts`
- `sapore-sdr/docs/sprints/SPRINT-02.md`
- `sapore-sdr/docs/sprints/SPRINT-02-REMOTE-GATE.md`
- `borelli-expansao/app/components/candidate-dossier.tsx`
- `borelli-expansao/app/components/pilot-lab/pilot-lab.tsx`
- `borelli-expansao/app/components/pilot-lab/tester-workspace.tsx`
- `borelli-expansao/app/components/pilot-lab/types.ts`
- `borelli-expansao/app/components/pilot-lab/views.tsx`
- `borelli-expansao/tests/candidate-dossier.test.mjs`
- `borelli-expansao/tests/dossier-actions.test.mjs`
- `borelli-expansao/tests/pilot-lab-visual-fixture.mjs`
- `borelli-expansao/tests/pilot-lab.test.mjs`

O workspace raiz não oferece uma linha de base Git versionada para esses diretórios: `borelli-expansao/`, `entregas/` e `sapore-sdr/` aparecem como não rastreados. Não houve commit automático.

## Auditoria da Definition of Done

| Requisito | Estado | Evidência autoritativa atual |
| --- | --- | --- |
| Usuário autorizado entra | pendente remoto | Dois usuários e memberships existem; falta concluir login e logout reais das duas contas. |
| Cria sessão fictícia | aprovado localmente | Testes da API criam sessões privadas, idempotentes e com candidato independente. |
| Conversa com agente real | primeira execução aprovada | Uma chamada real completou e gerou duas mensagens estruturadas com fonte Sapore aprovada. |
| Fluxo API → banco → fila → worker → n8n → modelo → callback | aprovado para uma execução controlada | O job fictício percorreu fila, worker, n8n, modelo e callback da API. A criação inicial foi administrativa no banco; o fluxo completo iniciado pelo frontend ainda precisa de login humano. |
| Mensagens, memória e versão persistem | aprovado em uma execução remota | Duas mensagens do agente, três fatos com evidência, fonte, versão, uso e evento foram persistidos. |
| Reload e nova autenticação preservam contexto | aprovado localmente; pendente no navegador publicado | Nova instância da API e novo token recuperam a mesma sessão e mensagem; a interface local voltou a listar a sessão após logout/login contra a fixture fictícia. |
| Outro usuário não acessa a sessão | aprovado localmente; pendente com contas reais | Listagem vazia e detalhe 404 para outro testador; RLS separa organizações. |
| Briefing correto e vinculado à versão | aprovado localmente; pendente real | Briefing persistido com `version_id` e `assignment_status=not_applicable`. |
| Pedido humano pausa sem Kapso | aprovado localmente; pendente real | Estado `human`; pós-handoff não altera nenhuma tabela observada; zero chamadas Kapso. |
| Tokens, latência e erros registrados | aprovado em uma execução real | 1.884 tokens de entrada, 463 de saída, 19.059 ms, tentativa 1 e erro nulo. |
| Testes, TypeScript e build | aprovado | 98/98 backend; 108/108 frontend; builds aprovados. |
| Desktop e mobile | aprovado localmente; pendente remoto | Tela restrita e workspace autenticado fictício aprovados em 1440×900 e 390×844, nos modos testador e revisor, sem overflow; Auth/API reais dependem do gate. |
| Zero mensagens de canal | aprovado até este ponto | Zero deliveries e nenhuma chamada a WhatsApp, Kapso ou CRM; somente convites administrativos de acesso foram enviados. |
| Evidências e limitações documentadas | em execução | Este relatório registra estado, riscos, hashes, custos e rollback; faltam evidências E2E. |
| Aprovação do responsável pelo produto | pendente | Demonstração real ainda não ocorreu. |

## Próximo gate

1. João confirma o convite e ambos concluem login/logout reais no frontend publicado.
2. Validar isolamento tester/reviewer e retomada da sessão fictícia pelo frontend, sem reativar o worker.
3. Aprovar um orçamento separado antes de qualquer cenário adicional da matriz; a autorização de R$ 2,00 foi consumida e encerrada com uma única chamada.

O formulário sem credenciais e a ordem operacional estão em [SPRINT-02-REMOTE-GATE.md](SPRINT-02-REMOTE-GATE.md).

## Rollback

O rollback atual é parar somente `sapore-sdr-api-1`, remover apenas o vhost dedicado depois de restaurar o backup do Caddyfile e revalidar o proxy, manter `CHANNEL_ENABLED=false`, retirar a versão 3 do Site se necessário e preservar banco, jobs e logs para diagnóstico. Quando o workflow existir, desativar somente esse workflow novo. Nunca apagar histórico nem repetir chamadas ambíguas.

## Definição de pronto

Ainda não atendida. A tela de acesso e o workspace autenticado fictício já foram verificados em desktop e mobile, mas a conclusão exige conversa real ponta a ponta, contas e isolamento reais, validação publicada em ambas as larguras, persistência remota após reload/logout, briefing e pausa humana sem Kapso, observabilidade de tokens/latência/erros, execução real da matriz de 15 cenários, zero envios externos, documentação final e aprovação do usuário.
