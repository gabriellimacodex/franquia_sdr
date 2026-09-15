# Sprint 4 — interface mobile e logout, 13/09/2026

**Progresso parcial de M5; sprint e meta ainda abertos.** Frontend v9 publicado na mesma URL e audiência. API/worker r7, workflow, modelo, snapshot, schema, memberships e orçamento não foram alterados. Nenhuma sessão fictícia ou mensagem foi criada nesta etapa, nem chamada ao modelo.

## Verificação real e correção

Chrome já autenticado, aba existente do laboratório. A recarga restaurou o acesso à lista; reabrir `05a61e` preservou as quatro mensagens e o estado pausado. O campo e Enviar ficaram desabilitados, coerentes com a lista. Não foi lida senha, cookie, token ou armazenamento de sessão.

- Desktop observado: 1920×907, documento na mesma dimensão, campo com limite inferior859px dentro da tela.
- Tela pequena autenticada: 390×844, documento sem overflow global, campo inferior807px. Na conversa longa `f9c2af`, nove mensagens, área própria602px/conteúdo1343px: scroll741→0 por interação real, página permaneceu em0 e campo fixo.
- Achado na v8: a regra mobile escondia o `<small>` identificador de cada teste. Cartões do mesmo cenário ficavam indistinguíveis.
- Correção: remover somente `.tester-session small { display:none; }` do breakpoint700px. Não alterar cadastro, seleção, envio, autenticação, polling ou responsividade do chat.
- Novo teste reproduziu a falha, depois passou; testa dois cenários de mesmo nome com IDs distintos e a ausência da regra que os escondia. Subset35/35; revisão independente sem bloqueador material. O teste CSS não substitui geometria real.

Após publicar, recarga autenticada bem-sucedida; screenshot e leitura DOM confirmaram `Teste 05a61e`, `Teste f9c2af` e `Teste 56f9e3` visíveis. Faixa horizontal: clientHeight89/scrollHeight91, largura390/conteúdo3835; a rolagem fica na faixa, sem overflow global. Identificadores têm altura16,5px. Em320×568, foi possível selecionar `f9c2af`; nove mensagens, documento320×568, campo inferior531px e pausa preservada. Screenshots foram inspecionados na ferramenta, não salvos como artefatos locais. São tamanhos de viewport do Chrome, não teste em aparelho físico/teclado virtual.

## Publicação e provas

Preparação a partir da v8 exata, em clone isolado `/tmp/sapore-s4-mobile.qosAzM/site`; árvore de trabalho do usuário preservada. As únicas diferenças do commit são CSS e teste.

- Baseline v8/rollback: `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_433376b1f5d48191964ae28be62887fe`, commit `d7ae860f45db76a76bffff7ae46342d8c5600301`; publicação anterior conferida como succeeded.
- Commit enviado: `63fd405b5b0cd1d267f0e840aa6b4320619c2e1d`. Branch remota conferida antes do push, HEAD completo lido depois do push. Clone permanece limpo.
- Build aprovado; **134/134 testes**, zero falhas/skips/cancelamentos,1,22992675s. Lint: zero erros/três avisos preexistentes. Nenhum pacote instalado/atualizado.
- Checagem adicional `tsc --noEmit --incremental false` não aprovada: quatro erros de tipos ambientais (`cloudflare:workers`, `Fetcher`, `D1Database`). O mesmo comando na v8 original reproduziu os mesmos quatro erros. É uma lacuna preexistente de configuração da checagem independente, não regressão deste CSS; não apresentar o frontend como TypeScript aprovado. Build e execução publicada funcionam. Preparar os tipos oficiais do runtime e repetir a checagem antes do fechamento M5.
- Pacote do helper Sites: `/tmp/sapore-s4-mobile.qosAzM/site-mobile.tar.gz`, SHA256gzip `6f1cee19fd2d34c3e6aee05a3902c592ecca6151924a761a9d1e4a1c6abdcbbb`; contém apenas saída construída/hosting e journalDrizzle vazio, sem migration ou source tree.
- Versão9: `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_d65cf8f4baf481919485709b4465e003`; hash do tar registrado pelo serviço `2464de0b4da6ec119fb00753c83c57cf8942c810336e9728d85225b1f10b310f`,48 arquivos/6.502.400bytes. Não confundir com hash do gzip local.
- Deploy `appgdep_6aa72f3b35e48191addbd88085061488`, **succeeded às23:18:30.285397UTC**, env revision1.
- Site ativo, latest version9; política completa de audiência idêntica antes/depois, modo custom/revisão2. URL: https://borelli-expansao.ana-mendes.chatgpt.site/laboratorio-sdr.
- Abertura automática no painel Codex indisponível; QA real ocorreu na aba Chrome existente. Não foi criado servidor local ou aba alternativa para contornar autenticação.

Hashes dos dois arquivos publicados, iguais aos do workspace: CSS `22a2277e6ed9dc534409dd86bb7b36823f702807d96f3cf6195c08a03365ffcb`; teste `c97c8288e9e831443b112513dcc18809c69ee98c8e47a3375133b4d76645511d`.

## Logout e pendências humanas

Após restaurar a viewport normal, clique em Sair produziu `Sessão encerrada.` e zero históricos visíveis. O cliente usa revogação `scope=local`, não logout global. Nova recarga terminou na tela de login, com Entrar visível e zero histórico/Sair. Isso verifica logout pela UI e ausência de restauração automática nessa aba; não afirma invalidar imediatamente todo JWT já emitido.

Não houve novo login: foi pedido a Gabriel que entre pessoalmente no Chrome e avise, sem enviar senha. Aba liberada como handoff, viewport temporária removida. Retomada pós-login, digitação/envio real mobile, erro/timeout publicado, isolamento entre papéis e validação pessoal de João continuam pendentes. Não converter a recarga autenticada anterior em prova de login após logout.

Auditoria somente leitura às **23:19:18.012002UTC**:31 reservas settled/zero pending,359.814 microUSD usados/640.186 disponíveis, jobs completed40/handoff9 sem outros estados, canais habilitados0/deliveries0/admins0/versões com outputContract explícito0. Gate original e teto total preservados.

## Próxima hipótese de fluidez

Revisão somente leitura identificou que o polling agenda30s quando oculto e não reage a `visibilitychange`: voltar à aba pode manter essa espera. Próximo teste local deve comparar retorno em6s versus timer atual31,2s, preservando mínimo2,5s entre inícios, ausência de sobreposição, seed do POST, cooldown de erro, deadlines e aborto. Não implementado nesta versão; melhora de retomada não cumpre M6 em primeiro plano.

Notificação pós-commit ainda precisa de medição: nas amostras atuais a cauda commit→detalhe é421–425ms com RTT137ms, menor que cinco viagens de uma nova consulta iniciada depois do aviso. Não aumentar frequência, retirar locks, mudar modelo ou contratar infraestrutura por inferência.

As skills de navegador/Sites conduziram a QA real e a preservação de audiência; TDD e revisão limitaram a correção à regra CSS demonstrada. Nenhum aceite financeiro/comercial/humano foi criado.
