# Sprint 4 — concorrência real da leitura de conclusão, local

13/09/2026. Verificação com dados exclusivamente sintéticos; **não é QA de modelo, performance remota ou aceite do sprint**.

## Ambiente e escopo

Imagem PostgreSQL já instalada, sem download: `postgres:17-alpine`, ID `sha256:dc17045ccfd343b49600570ea734b9c4991cf1c3f3302e67df51e3b402dd55c4`; servidor reportou PostgreSQL17.10, arm64. Contêiner dedicado `sapore-s4-lockcheck-20260913`,512MiB/1CPU, dados em tmpfs e publicação de porta exclusivamente127.0.0.1. Credenciais de fixture explícitas, nenhuma configuração do produto lida pelo teste.

`evaluations/completion-postgres.test.ts` aceita somente uma porta local entre1024e65535; host, usuário de fixture e banco de controle são fixos. Cada execução cria banco e papel novos. Usa sete definições de tabelas extraídas literalmente de001_sdr.sql; instala políticas de isolamento na fixture e usa papel NOSUPERUSER/NOBYPASSRLS para as duas conexões. Nenhuma migration do Supabase remoto ou dado real é utilizado. Sem pgvector/retrieval/modelo neste teste de bloqueios.

## Resultados incrementais

1. Pausa humana em transaçãoA; callbackB espera no advisory lock. A espera é observada em pg_locks, não suposta por um sleep. Após commit deA, callback retorna STALE_RESULT.
2. Após leitura agrupada, os locks de job/conversa/candidata continuam retidos. Uma terceira conexão recebe55P03 ao tentar cada FOR UPDATE NOWAIT. Depois do commit, todos ficam disponíveis.
3. Uma pausa e memória fictícia revertidas por rollback não aparecem no callback que aguardava. Conversa continua automatic/epoch0 e o canário não vaza.

Regressões de comportamento já implementado, acrescentadas uma por vez e executadas a cada passo:1/1,2/2 e **3/3 PASS**, última execução1,491110750s. Não alegar três novos ciclos RED→GREEN: não foi necessário alterar o módulo para esses casos passarem. Foram instâncias/conexões reais, não PGlite. RLS também bloqueou leituras sem scope.

## Integração local posterior

Um novo teste do Engine falhou porque não havia consulta agrupada(0≠1), então a leitura foi integrada **apenas no ramo laboratório** dentro do scoped existente. O ramo WhatsApp manteve suas consultas. Erros da porta não autorizam persistência: job ausente mantém404, stale mantém accepted=false, demais falhas retornam erro e provocam rollback.

Schema de versão, modelo, configVersion, contrato v1/v2, memória, guard, gravações, auditoria e settlement continuam depois da leitura e na mesma transação. A diferença temporal já documentada permanece: stale agora é checado após o comando que também carrega versão/histórico.

Teste novo passou(1/1); subset de controles/memória/financeiro/replay/rollback/timings passou **41/41**,13,408212959s. Foram atualizadas somente as expectativas instrumentais de três testes antigos para a nova forma/contagem de consultas; os asserts funcionais/ledger não foram removidos. Caminho de duas bolhas:13→9queries,1transação;1650versus2250ms **simulados** a150ms/viagem. Sem prova5/8s, sem publicação.

Hashes deste checkpoint:

- Engine:`e20153993743ab5320bf0613ef667ec96da5e90d52933b9a6396778e3f898abe`.
- Módulo:`5c16acb8f0517f6e5ea15908d526a2afacdd6c125470d7d552d2e07f4703b0cc`.
- Spec:`8ff79105dec41f1b5c22ef70f6b336e344e62b32969ee0917809fad2f99db5ca`.
- Teste PostgreSQL:`aeefe563a31df29a79e3273a1e5458141f2a26ab6fda78b043d9e3d2ece4eefe`.

Revisão independente da integração concluída: 21/21 testes e verificações adicionais de erro SQL, modelo/versão e deadline, sem bloqueador material. A [comparação integral simulada](SPRINT-04-META-LATENCIA-COMPLETION-20260913.json) mostrou ganho de cerca de meio segundo, insuficiente para 5/8 s. Suíte compartilhada final ainda depende do congelamento do coordenador em desenvolvimento. Não publicar essa redução de quatro consultas isoladamente como solução de latência. R7 remoto permanece inalterado.

### Prova adicional e encerramento da fixture

A versão final acrescentou a tabela `events` (oito definições literais de001) e a instrução de `channel.kind` da003 exclusivamente na fixture. Dois dispatches em conexões separadas disputam 60.000 microUSD sintéticos: o segundo espera no advisory lock observado em `pg_locks`, não vê a reserva antes do commit e, depois, recusa exceder a cota. Só o ranking pgvector é substituído por resultado vazio; header, contexto, ledger, locks e transações usam PostgreSQL real. A primeira execução encontrou coluna ausente na fixture, não defeito do produto.

Resultado final **4/4**, 1,055028292 s. Teste SHA256 `a52a62b536acec0e16665d8a82dca8af6ac5a677b0837ad749d414e96935c02c`. A integração compartilhada posterior passou **319/319 + TypeScript**, registrada no [dispatch integrado](SPRINT-04-META-DISPATCH-INTEGRADO.md).

Após verificar ID `842891dc366c9af7b5e36f7c16dd3c24919e333217b37d6c7771b0bcab36fcc7`, rótulo `completion-locks` e autoRemove, o contêiner `sapore-s4-lockcheck-20260913` foi encerrado por `docker stop`, com sucesso. Sua fixture sintética em tmpfs foi descartada automaticamente; não há dados reais ou serviços remotos afetados. Não está mais disponível para testes sem nova criação explícita.
