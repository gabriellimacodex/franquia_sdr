# Meta Sprint 4 — publicação isolada M2

11/09/2026. Autorizada pela meta ativa. **Publicação da correção específica, não encerramento de M2 completo, da meta ou do Sprint 4.** Nenhuma chamada paga foi executada nesta rodada.

## Artefato e verificação

- Base: pacote publicado r5, `/tmp/sapore-s410-backend.3GeTpw/sapore-sdr`.
- Candidato: `/tmp/sapore-m2-backend.LWAdCn/sapore-sdr`.
- Tar: `/tmp/sapore-m2-backend.LWAdCn/backend-m2-memory-only.tar.gz`, SHA-256 `6435482d94089b42e3a9d72fdfcb2c192faac3c402e0f8fc58f3e4cd0ac34582`.
- Manifesto adjacente `m2-backend-manifest.json`, SHA-256 `acfa755728a2167fa8e0e6cd4cb2b902dd08dea3e9d9c50e027ac51c3fc84867`.
- 101 arquivos, 98 idênticos; somente `src/memory-reply.ts`, `tests/memory-reply.test.ts` e `tests/engine-memory-reply.test.ts` alterados. Sem arquivos adicionados/removidos, segredos, node_modules, Git, financeiro v2 ou nova rota de avaliação.
- Dez ciclos RED→GREEN, 13 testes novos, revisão independente dos três achados de linguagem e 12 verificações extras aprovadas. Memória 30/30; pacote inteiro 200/200 e TypeScript no Node 24.13.1.
- Tar reextraído e 101 hashes comparados localmente; hashes do tar/manifesto novamente conferidos na VPS.
- Imagem Node 22.23.2 com TypeScript aprovado. Regressão **200/200** dentro da imagem em contêiner sem rede, sem env/credenciais, readonly, tmpfs, 1 CPU e 1 GiB; duração 343.200,396529 ms.

## Ativação e saúde

Release `/opt/sapore-sdr/releases/20260911T223521Z/sapore-sdr`.

Imagem `sapore-sdr:sprint4-memory-20260911-r6`, ID `sha256:672633c78fca9f42697fdbebba65565596d9fd74f10f402a29d64d0411f324c6`.

Antes de ativar, API/worker foram conferidos como r5 e o banco registrou zero jobs ativos às 22:43:40.470 UTC. Apenas os serviços `api` e `worker` do projeto Compose `sapore-sdr` foram recriados, com `compose.lab-budget.yaml` e os arquivos de ambiente/CA existentes.

- API iniciada 22:43:42.923439088 UTC; worker 22:43:42.916911922 UTC.
- Pós-deploy: API running/healthy, worker running; `/health` ok/outbound false e `/ready` ready. GET anônimo de `/v1/lab/sessions`: HTTP 401.
- Ambos mantêm laboratory, CHANNEL_ENABLED/NATIVE_CONTROL_VERIFIED/RETENTION_ENABLED false, gate `sprint3-continuous-20260910` e cap 1.000.000 microUSD.
- Hash no container: memória `47fbefe3dbcf9cb2a56b71c576e65eb440fc1d266724d7256c246a857d33074a`; engine r5 preservado `7904dd149ba5b6bbbd1dd841f0311e99799d492969a656734de77ef8aeb10332`.
- `lab-sessions.ts` remoto permanece `5013b657b1217d6388554057b8975e9c99c0fcf1bf1836c0f0ed11d1389a435e`; `server.ts`, `5cff0436d95174f87f82a5792ddc4fb9ab9c5e1c816c55d3528af5f5712c3085`. A nova rota local não foi publicada.

Auditoria pós-deploy 22:45:25.106803 UTC: **31 reservas liquidadas, zero pendentes, 359.814 microUSD usados / 640.186 disponíveis**, zero jobs ativos, canais habilitados e deliveries. Snapshot/modelo/hash legado preservados, outputContract NULL, zero financeiro v2 persistido. Nenhum frontend, workflow n8n, schema, membership, fonte comercial ou segredo alterado.

## Rollback preservado

R5 continua disponível: `sapore-sdr:sprint4-batching-20260911-r5`, ID `sha256:e66372da2b8b8b40e900c8815d602a6b4dcd1d43ffc4e44f3232fec99205faec`, release `/opt/sapore-sdr/releases/20260911T212600Z/sapore-sdr`. R4 também não foi removida.

Se uma regressão da M2 exigir retorno, executar no diretório da release r5, exclusivamente para API/worker:

```sh
SAPORE_ENV_FILE=/opt/sapore-sdr/secrets/runtime.env \
SAPORE_CA_FILE=/opt/sapore-sdr/secrets/supabase-ca.crt \
SAPORE_IMAGE=sapore-sdr:sprint4-batching-20260911-r5 \
docker compose -p sapore-sdr -f compose.yaml -f compose.lab-budget.yaml up -d --no-build api worker
```

Esse procedimento não foi executado nesta rodada. Preserva dados/ledger; depois requer repetir saúde, flags, imagem e jobs. R5 não corrige a frase futura ambígua; rollback é operacional, não solução funcional para ela.

## Limitações e nova evidência histórica

A correção remove formas reconhecidas de adoção futura do valor conflitante, preserva negativas/condições honestas e respostas separáveis. Padrões finitos e testes simulados não substituem a campanha real. Não houve nova medição E2E nem demonstração de 5/8 s.

Na inspeção visual somente leitura, a sessão existente `05a61ec1-5839-4fe7-bf1e-b7fe63c84c02` apareceu pausada com compositor desabilitado, aviso coerente e histórico visível. Isso confirma apenas esse estado desktop; não é validação de mobile/logout/reviewer ou de resposta nova na r6.

A chamada histórica de 21:46:35.798265 UTC nessa sessão explica o delta de 7.913 microUSD observado no início da meta, sem inferência de autoria. O modelo produziu duas perguntas: confirmação de cidade e pergunta sobre operação. Evento e guardReview privados confirmam `multiple_questions`; o guard bloqueou a resposta e pausou. Uma tentativa, 2.061 tokens de entrada/184 saída, reserva 52.365 liquidada em 7.913; zero fatos/relações. Intervalo transacional 9.604,621 ms não é E2E. Reprodução local confirmou o predicado sem reconstruir os demais campos brutos. **É outra falha de condução preexistente, não corrigida pelo pacote M2.** Deve ser tratada sem relaxar evidência/controle ou esconder a rejeição.
