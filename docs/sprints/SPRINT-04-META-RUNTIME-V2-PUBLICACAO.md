# Meta Sprint 4 — pacote r7 de suporte publicado

11/09/2026, checkpoint 23:17 UTC. **Imagem construída, ainda não ativada neste checkpoint.** Publicar suporte de runtime não publica ou aprova o snapshot financeiro v2, não concede papel administrativo e não encerra o sprint.

Atualização em 13/09/2026: resultado do mesmo processo de teste recuperado, sem reiniciá-lo: **238/238 PASS**, zero falhas/skips/cancelamentos, 464,702839461 s. API/worker r6 e IDs das imagens r6/r7 foram conferidos antes da ativação r7 descrita abaixo. A retomada não pressupõe execução ininterrupta desde 11/09.

## Recorte e artefatos exatos

- Base isolada r6: `/tmp/sapore-m2-backend.LWAdCn/sapore-sdr`.
- Pacote candidato: `/tmp/sapore-v2-support.BVM8rG/sapore-sdr`, 112 arquivos. São 15 diferenças contra a base: sete arquivos de runtime, dos quais três novos, e oito testes novos.
- Runtime: `domain.ts` exporta o mesmo reconhecedor de capital; `engine.ts`, `financial-reply.ts` e `financial-version.ts` suportam contrato v2 por snapshot imutável; `question-reply.ts` contém o reparo delimitado de pergunta extra; `lab-sessions.ts` e `server.ts` oferecem a rota privada administrativa de avaliação. Não existe ativação de snapshot no startup.
- Excluídos do pacote: harness de latência, planejador, medidor de bounds T1, controlador e protótipo de consultas agrupadas. Memória r6, n8n, migrations, scripts, lockfile, Dockerfile e Compose preservados. Sem arquivos locais de ambiente, segredos, Git ou node_modules no tar.
- Tar `backend-v2-support.tar.gz`: SHA-256 `6ae0310fb9768dc48e085979e69a34920d319b7e2d079af308e14f433a54bbb1`.
- Manifesto `backend-v2-support-manifest.json`, criado 23:12:44.555 UTC: SHA-256 `d5f321a886249e4d064224a61feab404a34246d292f2a73ee24bcb7b20622599`.
- Tar reextraído localmente: 112 caminhos e hashes conferidos. Tar/manifesto conferidos na VPS. Nova conferência readonly: 112 arquivos da release e os 56 arquivos previstos no conteúdo da imagem, todos iguais ao manifesto. Os demais são testes/Compose/artefatos de avaliação não copiados pelo Dockerfile.

## Testes e imagem

Revisão independente do recorte resolveu 37 dependências locais, executou 38/38 testes focados e TypeScript. Pacote completo local: **238/238**, 56,756434375 s, Node 24.13.1, concorrência quatro, TypeScript aprovado. Não confundir com os 249 testes da árvore compartilhada anterior ou com os novos protótipos.

Release: `/opt/sapore-sdr/releases/20260911T231330Z/sapore-sdr`.

Imagem: `sapore-sdr:sprint4-v2-support-20260911-r7`, ID `sha256:e7344368187fd0b13e9727a38ce4cf6267850fc4c98ebd45551b5ef9a8081229`. Build TypeScript aprovado; base Node 22-alpine fixada por digest. Regressão completa sem rede, env ou credenciais, readonly, tmpfs, 1 CPU/1 GiB, testes/evaluations/Compose da release montados somente leitura. **238/238 aprovados**, resultado recuperado em 13/09/2026 do processo original; não é nova bateria nem avaliação paga.

## Baseline remota desta continuação

- API/worker continuam na r6, saudáveis/prontos; flags e gate originais confirmados nos dois serviços. Rollbacks r6 e r5 disponíveis.
- Banco 23:08:59.637905 UTC: 31 reservas settled, zero pending, **359.814 usados / 640.186 disponíveis** na cota de 1.000.000 microUSD. Zero chamadas pagas iniciadas pela equipe da meta.
- Banco 23:09:03.683471 UTC: zero jobs ativos/canais/deliveries/drafts/admins/versões financeiras v2. Snapshot ativo legado `sapore-v1-a1a330f07cd0`, hash `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`, modelo `gpt-5.4-2026-03-05`, outputContract NULL.
- Consulta pela conexão real do runtime: papel `sdr_runtime`, privilégios de leitura em drafts/versions e escrita em drafts já existentes. Nenhum grant ou migration foi executado. Isso resolve a dúvida de instalação dos grants, não a ausência de admin da aplicação.
- n8n inspecionado em sessão autenticada, somente pela interface: histórico mostra `Sprint 4 — instrumentação de tempos r2 (Published)`, 11/09 às 13:48:35 locais. Mesmos cinco nós de job/preparo/modelo/envelope/callback; nota publicada diz financeiro v2 não incluído. Não houve Execute/Publish/Deactivate ou leitura de credenciais. A inspeção confirma rótulo/data publicados, não um novo hash do código inteiro do workflow.
- Frontend não alterado nesta continuação. Nenhuma membership, snapshot, fonte comercial, credencial, schema ou audiência alterada.

## Ativação em 13/09/2026 e retorno

Após aprovação da imagem, nova auditoria confirmou saldo/reservas, zero jobs/admins/drafts/v2, r6 saudável, seis flags originais e rollback. Somente API/worker foram recriados com os dois Compose, ambiente/CA existentes e `--no-build`.

- API iniciada `2026-09-13T22:36:27.104020595Z`; worker `2026-09-13T22:36:27.102213085Z`.
- Ambos usam o ID r7 acima. API running/healthy, worker running; `/health` ok/outbound false e `/ready` ready.
- GET anônimo de sessões e POST anônimo da nova rota de avaliação retornaram **401**, sem criar sessão ou job. Não é validação positiva com admin.
- Nos dois serviços: laboratory, CHANNEL_ENABLED/NATIVE_CONTROL_VERIFIED/RETENTION_ENABLED false, gate original e cap1.000.000.
- Auditoria 22:37:10.590259 UTC: **31 settled/0 pending, 359.814 gastos/640.186 disponíveis**, sem gasto novo.
- Auditoria 22:37:42.012510 UTC: snapshot/modelo/hash legado idênticos, outputContract NULL; zero jobs ativos/canais/deliveries/versões financeiras v2. Nenhuma membership, migration, fonte, audiência, frontend, workflow ou credencial alterada.

Não houve campanha paga nem ativação de financeiro v2. QA com modelo, latência, validações de UI/papéis e aceites humanos continuam pendentes. R7 é suporte necessário e reparo delimitado, não encerramento do sprint.

Rollback r6 preservado: `sapore-sdr:sprint4-memory-20260911-r6`, ID `sha256:672633c78fca9f42697fdbebba65565596d9fd74f10f402a29d64d0411f324c6`. Executar exclusivamente no diretório `/opt/sapore-sdr/releases/20260911T223521Z/sapore-sdr` se for necessário reverter esta publicação:

```sh
SAPORE_ENV_FILE=/opt/sapore-sdr/secrets/runtime.env \
SAPORE_CA_FILE=/opt/sapore-sdr/secrets/supabase-ca.crt \
SAPORE_IMAGE=sapore-sdr:sprint4-memory-20260911-r6 \
docker compose -p sapore-sdr -f compose.yaml -f compose.lab-budget.yaml up -d --no-build api worker
```

Retorno preserva dados/ledger; exige nova verificação de saúde/flags/jobs. R6 não contém a nova rota nem o suporte v2: não usar esse rollback depois de ativar um snapshot incompatível sem reavaliar o plano. Nesta rodada não há snapshot v2 persistido ou publicado.
