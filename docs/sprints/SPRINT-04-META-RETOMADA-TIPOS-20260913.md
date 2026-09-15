# Sprint 4 — retomada da aba e tipos do frontend

Checkpoint de 13/09/2026, 23:36 UTC. Frontend **v10 publicado**, mesma audiência; Sprint 4 e meta **não concluídos**. Nenhuma chamada paga iniciada nesta rodada.

## Escopo entregue

- Quando uma consulta termina em segundo plano com job ativo, a volta à aba passa a remover a espera adicional de background. Preserva a cadência ativa de 2,5 s, piso de 500 ms após consulta lenta, atraso inicial integral após POST, cooldown de erro e cancelamento. Não antecipa consulta de job expirado, ocioso ou desconhecido nem abre segunda cadeia de polling.
- A resposta JSON de autenticação é tratada como desconhecida até conferir objeto e `expires_in` numérico, finito e positivo. A validação existente dos tokens/usuário permanece; payload inválido não salva sessão nem fornece token à API. A proteção de geração contra logout concorrente continua antes de persistir a sessão.
- Tipos oficiais do runtime Cloudflare gerados da configuração real de build; novo `npm run typecheck`, após `npm run build`, verifica o source completo. Arquivos gerados ficam em `.wrangler/`, ignorados no lint como artefatos, não no TypeScript. Não foram criados stubs, `any` manuais, binding fictício ou exclusões de source para obter aprovação.
- D1 continua opt-in/desligado (`d1: null`, schema vazio). O helper existente tipa o binding como opcional localmente e conserva seu erro quando ausente; binding fornecido é passado intacto ao Drizzle. Sem remoção do scaffold ou provisionamento de banco.

Sem alteração de política/configuração Auth, memberships, audiência, credenciais, APIs do Supabase, RLS/grants, schema, dependências, lockfile, fontes comerciais, snapshot, modelo, n8n, API/worker ou flags operacionais.

## Evidência e limites

1. Reprodução do polling antes da correção: retorno à aba no segundo 6, resposta visível na árvore do componente somente em 32,4 s. Depois: 7,2 s, com as mesmas duas leituras até essa resposta; no máximo uma em voo. **Relógio/rede/modelo simulados**, não E2E de navegador nem aceite M6.
2. Quatro regressões adicionais: alternância rápida/consulta lenta; erros 429/500 com rascunho; seed POST/cancelamento/desmontagem; deadline que expira durante a espera. No último, `Date.now` acompanha o relógio simulado por injeção isolada apenas no loader do teste; não foi confundido com `performance.now` nem alterado globalmente.
3. Auth RED: payload `null` causava `TypeError` ao ler `expires_in`. GREEN: teste com sete formatos inválidos e ambos os grants (password/refresh), sem salvar ou encaminhar sessão. Subconjunto chat/Auth **41/41**, 830,824875 ms. Não comprova todo valor extremo nem JSON sintaticamente inválido.
4. Checagem de tipos original da v9: quatro erros de tipos/módulo ausentes. Geração oficial revelou duas falhas de JSON desconhecido e duas de binding D1 ausente. Após correção do JSON, RED isolado com somente os dois erros `env.DB`; após contrato opcional, TypeScript completo GREEN. Teste de contrato D1 **1/1**, sem conexão real e sem necessidade de D1 para o laboratório.
5. Pacote final: `npm test` (build + **141/141**, 1.501,862291 ms nos testes), `npm run typecheck` **exit 0** e lint **zero erros/três avisos preexistentes**. Avisos: `<img>` em access/screens e variáveis testResult/notify em app/page. Não são novas falhas introduzidas.
6. Revisão independente de Carson no polling/Auth/deadline, sem bloqueador material; Hypatia no contrato D1/ferramental, incluindo checagem de tipos e helper em memória. Adotada sua recomendação de desativar o banner/consulta automática de atualização no typecheck. Sem instalação ou chamadas de modelo nos testes.

`typecheck` usa Wrangler 4.92.0 já instalado, `--config dist/server/wrangler.json --strict-vars=false`, desativa carregamento dotenv, métricas e banner. Na verificação isolada foi executado com ambiente limpo, configuração/logs temporários e aprovação para listener local. A geração não é uma operação remota no Supabase.

Referências verificadas: [tipos oficiais Cloudflare](https://developers.cloudflare.com/workers/languages/typescript/#generate-types-that-match-your-workers-configuration), [contrato Auth de tokens](https://github.com/supabase/auth/blob/master/openapi.yaml), [changelog Supabase](https://supabase.com/changelog). As alterações de quebra consultadas não exigiram mudança no grant de senha/refresh usado neste projeto hospedado.

## Publicação exata e rollback

- Base v9 limpa: commit `63fd405b5b0cd1d267f0e840aa6b4320619c2e1d`, preservada em `/tmp/sapore-s4-mobile.qosAzM/site`.
- Novo pacote isolado: `/tmp/sapore-s4-resume.dfMxze/site`; dez arquivos diferentes da v9, sem incorporar a árvore suja inteira. Mudanças correspondentes também preservadas no workspace.
- Commit enviado e conferido após push: `415aa7dcd0a45e620ec13c326b61fa1e2ffb67b3`.
- Versão v10: `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_dbcfd0ae20e08191a5a96904eb4c7649`.
- Deploy: `appgdep_6aa73315f0f88191b9dcb9e7b4fc82d6`, **succeeded em 23:34:57.003389 UTC**, env revision 1.
- Audiência completa comparada antes/depois: **idêntica**, custom/revisão 2. Não houve janela automática privada nem mudança de compartilhamento.
- Arquivo `/tmp/sapore-s4-resume.dfMxze/site-resume.tar.gz`: SHA-256 `c30cd8c684597299774e9c98d9bb77c1e60d962ac25a30dd5f7f67a278bdec96`.
- Tar normalizado registrado por Sites: SHA-256 `587963d15b6c639aab24f4d9eb82f19ba6983b2396459cfba23b6ea263796bff`, 59 arquivos/6.666.240 bytes. Somente build/hosting/journal vazio, sem `.env`, `.git`, source, credenciais ou tipos gerados. Scan delimitado de padrões de chaves privadas não encontrou correspondências; isso não é prova universal de ausência de segredos.
- Configuração real do build SHA-256 `f4adf351b2136969e2cc51a435cd8d6c2a6f73f29a0293805df28b51f0b21d27`, igual à v9.
- Rollback v9 disponível: versão `appgprj_6a9c60a594dc8191a045759b9a5479f1~appgver_d65cf8f4baf481919485709b4465e003`. Nenhuma versão/artefato foi apagado.

## Conferência pós-publicação e orçamento

URL: https://borelli-expansao.ana-mendes.chatgpt.site/laboratorio-sdr

O handoff automático ao painel Codex retornou ferramenta indisponível; não foi repetido. Conferência pelo Chrome existente funcionou: recarga, disponibilidade final e formulário de login visíveis; screenshot/DOM em 1920×907 sem overflow global, zero cards/histórico privado. **Usuário ainda deslogado**; nenhum login foi inventado/automatizado, nenhuma senha/token/storage foi lido. A aba foi liberada como handoff, sem modificar a viewport. Aguardando Gabriel entrar novamente e avisar para validar a retomada autenticada. A prova mobile da v9 continua histórica, não foi repetida nem atribuída à v10.

API após deploy: `/health` ok/homologation/outbound false; `/ready` ready; GET anônimo `/v1/lab/sessions` **401**. API/worker não foram publicados nesta rodada; referência r7 mantida, n8n/snapshot sem alteração.

Auditoria Supabase pré às 23:33:28.895963 UTC e pós às **23:35:38.317680 UTC**: 31 reservas, todas liquidadas; zero pendentes; **359.814 microUSD usados/640.186 disponíveis** na mesma cota de 1.000.000. Todos os estados dos jobs: completed40/handoff9; zero canais habilitados/deliveries/admins. Teto total R$10 e gate `sprint3-continuous-20260910` preservados. Zero chamadas pagas iniciadas pela equipe nesta continuação, nenhum e-mail/envio externo/alteração de acesso.

## O que segue obrigatório

- M3/M6 contextual continua reprovado/sem nova bateria; corrigir gargalo efetivo API–banco e avaliar descoberta pós-commit com medida, sem prometer que esta retomada resolve 5/8 s. Não publicar o backend local como solução comprovada nem gastar em repetição sem hipótese/plano.
- Campanha financeira real/adaptadores, estimativa total/T2, gates 30×2 por suíte e média humana ≥4; snapshot v2 não homologado/ativo.
- QA autenticada restante, papéis, João pessoalmente e aceite comercial de Gabriel. Autorização específica tester→admin de Gabriel permanece pendente; indicação anterior não foi convertida em promoção.
- Sem processo de teste/push/deploy ativo ao finalizar este registro. Estado da meta: **ativo, não completo**.
