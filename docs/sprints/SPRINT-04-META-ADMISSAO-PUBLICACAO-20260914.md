# Sprint 4 — admissão runtime e aplicabilidade da evidência

14/09/2026 UTC. **r10 publicada na API/worker às 04:45:14 UTC e verificada. Meta ativa, Sprint 4 não encerrado.**

## Avanço e escopo

A continuação anterior produziu progresso: composição privada e 568 testes. Esta etapa corrigiu uma divergência com o plano original e preparou o recorte necessário para que o runtime publicado reconheça e fiscalize a admissão da campanha. Não alterou casos, critérios de qualidade, identidades, orçamento ou fontes comerciais.

### Bruto indisponível, sem requisito retroativo

O [plano de avaliação](SPRINT-04-META-PLANO-AVALIACAO.md) exige preservar o bruto **quando disponível**, declarar sua ausência e não reconstruí-lo. O vinculador anterior exigia prova de existência mesmo quando o arquivo declarava que o runtime não o reteve. Esse bloqueio artificial foi corrigido somente em `sprint4-reviewed-receipt.ts/.spec.ts` e seu teste.

A lacuna permanece no packet/pacote. Referências legadas dessa lacuna são metadados não verificados, nunca prova de existência ou substituto da revisão humana; `rawArtifactRef` continua `null`. O8 exige identidade, julgamento e prova humana vinculados. Falhas do guard/modelo, de T1 ou do julgamento humano continuam bloqueantes. Digest e retomada legados preservados; nenhum critério O1–O7 foi dispensado.

Um RED→GREEN e três caracterizações adicionais: **16/16 focais + TypeScript**. Revisão independente aprovada. Consolidada **572/572 + TypeScript**, `04:31:15.963→04:33:52.406 UTC`, 153.159,555375 ms de testes, 83 arquivos de testes, fonte estável. [Metadados](SPRINT-04-META-APLICABILIDADE-REGRESSAO-20260914T043115963Z.json), [TAP](SPRINT-04-META-APLICABILIDADE-REGRESSAO-20260914T043115963Z.tap). Não são testes reais de modelo ou avaliações humanas.

### Pacote runtime independente

Partiu da r9 arquivada, não da árvore local inteira. Exatos **131 arquivos e cinco diferenças**:

- `src/lab-sessions.ts`: admissão opcional no envio privado; autoridade administrativa atual, pins, prazo, replay e evento/marcador vinculados à transação.
- `src/laboratory-dispatch.ts/.spec.ts`: confere admissão, dono, versão e teto antes de reservar/enviar; preserva marcador privado fora do payload do modelo.
- `src/campaign-admission.spec.ts`: contrato novo de restrição por turno, não concessão de autoridade.
- `tests/campaign-admission.test.ts`: 13 testes; os 301 anteriores foram preservados.

Não muda Engine/worker/Store/orçamento, dependências, migrations, Auth/RLS, snapshot, n8n ou frontend. Os módulos privados de campanha/recibos e o script determinístico adicional não entram no pacote. Nenhuma migração remota ou configuração de privilégios foi executada.

Pacote **314/314 + TypeScript**, terminal `04:33:53.076 UTC`, testes 123.385,376625 ms, 57 arquivos de teste. Os dois tars (baseline/candidato), membros regulares, conteúdo e hashes foram conferidos, além de 412 imports relativos. Fonte e manifesto estáveis após os testes. [Manifesto](SPRINT-04-META-ADMISSAO-PUBLICACAO-PACOTE-20260914.json), [verificação](SPRINT-04-META-ADMISSAO-PUBLICACAO-PACOTE-VERIFICACAO-20260914.json), [TAP](SPRINT-04-META-ADMISSAO-PUBLICACAO-PACOTE-20260914.tap), [conteúdo do tar](SPRINT-04-META-ADMISSAO-PUBLICACAO-PACOTE-CONTEUDO-20260914.json).

Tar `/tmp/sapore-s4-admission-runtime-3C62TY/backend-admission-runtime.tar.gz`, SHA256 `7f7f9610b5fda819625b4a6bd97f5f503c4f60d481840db17b8caad9c283e7c7`. Manifesto SHA256 `fb15e6233977b0fa1bb37137222e6e62dc3da7214f69c1c0341568653d250bbb`. Artefatos anteriores preservados.

## Baseline remota revalidada

Consulta READ ONLY **04:27:17.882271 UTC**: Gabriel admin ativo, João reviewer ativo; 31 reservas liquidadas, **359.814 microUSD contabilizados/640.186 disponíveis**, zero pendentes/desconhecidas em qualquer gate, jobs ativos/desconhecidos, canais habilitados ou deliveries. Zero revisões humanas, versões financeiras v2, drafts, validation runs ou publicações financeiras. Snapshot legado `sapore-v1-a1a330f07cd0`, hash `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`, modelo `gpt-5.4-2026-03-05`.

Consulta READ ONLY **04:34:06.496018 UTC**: zero mensagens de candidato de Gabriel nas últimas 24 horas; 100 vagas nessa fotografia, não garantia futura. Os 31 custos históricos liquidados variam de 5.750 a 16.608 microUSD, média 11.606,903225806453. São usos históricos do legado, não previsão conservadora da campanha v2 ou cálculo de saldo adicional mínimo. T2/custo futuro continuam sem medição; 640.186/72 ≈ 8.891,47 é só uma condição aritmética de média, ainda com folga necessária para cada reserva intermediária. Não iniciar a campanha alegando viabilidade provada.

API/worker r9 novamente confirmados, mesmo ID `sha256:3e2c5c7f43b79231fb24c2913e37abea82d40e17408858065f1d54ebe99b19ce`, ambos running/zero reinícios, iniciados `03:53:28 UTC`. API healthy e `/health` ok/outboundfalse. Seis flags não secretas conferidas: laboratory, CHANNEL/NATIVE_CONTROL/RETENTION false, gate `sprint3-continuous-20260910`, limite 1000000. Supabase ACTIVE_HEALTHY, região us-east-2. Isso não demonstra login da aplicação; não foi obtida credencial ou sessão humana nesta etapa.

## Imagem verificada e resultado terminal

Release nova e isolada `/opt/sapore-sdr/releases/20260914T043000Z/sapore-sdr`; tar/manifesto e 131 hashes conferidos após transferência. Extração em Linux emitiu avisos de atributo macOS `com.apple.provenance` ignorado, mas terminou exit0 com todos os hashes de conteúdo corretos. Não houve extração sobre uma release anterior.

Imagem construída com Node22 fixado, TypeScript aprovado: `sapore-sdr:sprint4-admission-20260914-r10`, ID imutável **`sha256:cff18e63267fd088a36079347c62d6e928d4be478d83b9cdf456109aa3bf395c`**. Conferência independente de **65 arquivos internos** da imagem contra manifesto passou; testes/fixtures/Compose são montados somente leitura no container de regressão.

O mesmo container **`sapore-s4-r10-regression-20260914`**, ID `09f99cf55668896b115eb18eb11fc7aa899094d9ec90ecc0804782a810793c83`, executou de **04:35:16.072542070 a 04:43:51.510141434 UTC**, sem reinício. Rede `none`, rootfs read-only, sem env/credenciais do runtime, 1 CPU, 1 GiB, 128 PIDs, capacidades removidas e tmpfs. Comando `node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/*.test.ts`.

**Resultado terminal: 314/314, exit 0, zero falhas/cancelamentos/skips/todo e sem OOM**, 515.215,732738 ms. [Inspeção e resumo](SPRINT-04-META-ADMISSAO-PUBLICACAO-IMAGEM-20260914.json), [TAP integral](SPRINT-04-META-ADMISSAO-PUBLICACAO-IMAGEM-20260914.tap), [stderr vazio](SPRINT-04-META-ADMISSAO-PUBLICACAO-IMAGEM-20260914.stderr.log). TAP SHA256 `f29273f4df28e884cb93b1a5453e80cbf8d5130b2eb7ca45019a1be906935107`; inspeção SHA256 `7dcc39dafb99105cb9b7ca63a7f98e806d7f5e644058dd2b54ac7a3af1abf112`. O coletor confere ID e imagem e lê logs pelo ID imutável.

Após arquivar e conferir os hashes, somente esse container sintético terminal foi removido às **04:46:55 UTC**. Imagem, release, logs e rollback preservados; nenhum dado do laboratório removido. Não existe teste vivo a recuperar e não se deve repetir a suíte por um checkpoint anterior dizer “em execução”.

## Gate de ativação e rollback

Scripts locais `/tmp/sapore-s4-r10-preflight.sh` e `/tmp/sapore-s4-r10-activate.sh` revisados independentemente. A revisão identificou dois riscos antes da execução: tag não vinculada por assertion ao teste, e ingresso de SEND entre auditoria e ativação. Ambos foram corrigidos no procedimento:

1. Exigir imagem testada exit0/sem OOM, TAP integral 314/314 e ID imutável igual ao tag candidato e ao container testado.
2. Confirmar inventário do par API/worker e comparar configuração resolvida com ambos os containers ativos, sem imprimir segredos. Preservar `compose.lab-budget.yaml`, env/CA e gate/cota.
3. Auditoria DB independente antes da parada. Parar **somente API e worker do laboratório**, eliminando ingresso e claim; auditar novamente pelo conector, sem depender da API parada.
4. Ativar somente se zero jobs/reservas pendentes/desconhecidos, image ID ainda igual e ambos parados. Usar Compose explícito `up -d --no-build --no-deps api worker`.
5. Conferir imagem, saúde, negação anônima, flags em ambos, ledger e ausência de ações externas após subir.

Rollback r9 permanece na release `20260914T034500Z` e imagem `sha256:3e2c5c7f43b79231fb24c2913e37abea82d40e17408858065f1d54ebe99b19ce`. Não voltar a worker r9 com jobs admitidos pendentes, pois ele não fiscaliza essa admissão. Se o gate pós-parada detectar trabalho, não apagar/reprocessar para obter zero: restaurar operação compatível e encaminhar/auditar o trabalho antes da troca. Nenhuma alteração de DNS, frontend v11, workflow, infraestrutura contratada ou canais.

## Ativação e verificação executadas

Preflight exit0: configuração resolvida idêntica à de **ambos** os containers r9, gate/cota iguais e ID da imagem testada igual ao tag candidato. Auditoria independente **04:44:44.359676 UTC**: zero jobs ativos/desconhecidos e reservas pendentes em todos os gates. API e worker foram parados; a auditoria pelo conector, **04:45:04.252797 UTC**, confirmou novamente zero. Somente então o par foi recriado com `--no-build --no-deps`, sem outro serviço ou configuração alterados. [Registro da operação e três auditorias](SPRINT-04-META-ADMISSAO-PUBLICACAO-OPERACAO-20260914.json).

- API: container `7b33450ef41e63d0d6ca4face08cf90e27c8dbb010db25de6ba879e5725c4412`, início **04:45:14.719911522 UTC**.
- Worker: container `8942ce0e74ba4c30edd4762608544852916a2cd39a5f05e128acfbd24aabc154`, início **04:45:14.717204586 UTC**.
- Ambos na imagem r10 `sha256:cff18e63267fd088a36079347c62d6e928d4be478d83b9cdf456109aa3bf395c`, running e zero reinícios. API healthy; worker não possui healthcheck próprio.

[Smoke às 04:46:14.373 UTC](SPRINT-04-META-ADMISSAO-PUBLICACAO-SMOKE-20260914.json): cinco GET públicos, sem Authorization, redirects, retries ou configuração implícita de curl. `/health` e `/ready` 200; `/v1/me`, `/v1/lab/sessions` e rota de histórico de revisão com UUID fictício retornam 401 `AUTHENTICATION_REQUIRED`. As seis flags foram conferidas em ambos: laboratory, CHANNEL/NATIVE_CONTROL/RETENTION false, gate contínuo original, cota 1000000. Isso demonstra disponibilidade e negação anônima, **não login, admissão real ou campanha E2E**.

A [primeira tentativa do helper](SPRINT-04-META-ADMISSAO-PUBLICACAO-SMOKE-TENTATIVA1-20260914.json) falhou antes dos GETs porque o template de inspeção acessava `Health` ausente no worker. Foi corrigido o coletor para tratar o campo opcional; nenhuma fonte do runtime mudou. A falha está preservada, não foi tratada como regressão da aplicação nem omitida.

Auditoria final READ ONLY **04:46:20.034637 UTC**: 31/31 reservas liquidadas, zero pendentes/desconhecidas em qualquer gate; **359.814 microUSD contabilizados e 640.186 restantes**. Zero jobs ativos/desconhecidos, canais habilitados, deliveries, revisões humanas, versões financeiras v2, drafts, validation runs ou publicações. Gabriel admin e João reviewer ativos; modelo/snapshot legado inalterados. Nenhuma nova chamada paga ou ação externa.

## Pendências reais

Não houve chamada paga, e-mail, reset, novo usuário ou nota humana. O teto total R$ 10 e a cota técnica original permanecem intactos. A publicação desta restrição foi concluída; não executa campanha, não ativa o snapshot financeiro e não prova melhora de latência.

Ainda faltam fontes operacionais autorizadas de prontidão/revisão/provas, agregação fiel das 60 avaliações finais, viabilidade/T2 medidos, acesso autenticado, campanha e publicação financeira com gates humanos, M6 real, QA autenticada/papéis, validação pessoal de João e aceite comercial de Gabriel. Infraestrutura proposta continua sem autorização; não é automaticamente indispensável nem autorizada. Não fabricar trabalho ou novas restrições para substituir essas dependências.
