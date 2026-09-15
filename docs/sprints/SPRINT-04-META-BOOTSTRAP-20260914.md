# Sprint 4 — retomada da criação de sessões e reconciliação

Etapa **implementada, testada e revisada localmente**, checkpoint de 14/09/2026 às 01:51:35 UTC. Não é campanha conversacional executada, publicação financeira, M6 ou encerramento. O turno anterior respondeu apenas ao pedido de status; esta continuação implementa o bootstrap que faltava ao executor HTTP. Nenhuma chamada paga, credencial real, publicação ou operação remota nesta etapa.

## Comportamento implementado

`Sprint4Bootstrap` recebe plano canônico, execução e dependências explicitamente fornecidas. Não busca credenciais no ambiente, navegador ou disco. Usa somente `Sprint4Http`, as rotas existentes e o modelo já fixado no plano. Sessões M6 usam a rota normal; sessões de avaliação usam a rota administrativa de rascunho, sem publicar ou alterar a versão ativa.

1. Valida a matriz, execução, proprietário e versão/hash/modelo. Rótulo e cenário derivam da execução, não de parâmetros livres do operador.
2. Lê o registro privado existente. Se houver observação confirmada compatível, devolve o registro histórico sem novo HTTP. Se existir só intenção, não recria nem gera novo UUID.
3. Sem intenção anterior, confere a identidade administrativa retornada pelo servidor e grava a intenção única **antes** do POST. Somente a aquisição confirmada permite criar.
4. Uma resposta compatível é registrada uma vez. Perda da resposta ou da confirmação local deixa a execução dependente de reconciliação; nenhum retry automático.
5. Disputa de criação relê o vencedor e confere seus vínculos. Não adota o UUID perdedor nem uma intenção de outro plano/caso/ator.
6. `reconcile` não cria intenção nem faz POST. Pode reconhecer uma sessão existente já pausada/usada. Ausência em uma leitura não prova que o POST não poderá terminar depois e nunca permite reenvio.

`session-recorded` **não significa pronta**, publicada com aprovação, executada, paga ou aprovada por pessoa. Prontidão, admissão, ledger, sequência e aceites permanecem controles separados. Erros de armazenamento não são apresentados como prova de que não houve criação anterior. O contrato de sucesso exige observação, nunca somente intenção.

## Armazenamento privado

`Sprint4BootstrapStorage` usa SQLite próprio, separado do journal de mensagens. Exige diretório absoluto dedicado, proprietário atual e permissão 0700, contendo somente `sprint4-bootstrap.sqlite` e seu rollback journal. Arquivos 0600, regulares, sem symlink/hardlink; identidade de inode conferida. Inicialização explícita aceita somente diretório vazio; reabrir não cria, limpa ou migra estado.

Intenções e observações são append-only pela interface, com INSERT transacional e confirmação de COMMIT antes de sucesso. Plano/ator/target ficam fixos por run. Request, sessão e candidato não podem ser reutilizados entre execuções, inclusive por variação de maiúsculas em UUIDs; JSON/hash originais continuam exatos. Uma consulta única dá snapshot coerente à leitura, evitando falso estado corrompido se outro processo gravar entre etapas.

Configuração: `journal_mode=DELETE`, `synchronous=EXTRA`, `fullfsync=ON`, `foreign_keys=ON`, timeout de lock limitado. As provas de corrida/SIGKILL demonstram recuperação entre processos; não são ensaio de queda elétrica nem garantia independente do hardware/filesystem.

### Achado de revisão e correção também no journal existente

A revisão independente reproduziu INSERT seguido de falha injetada em **COMMIT e ROLLBACK**. Antes da correção, o handler falhava, mas a mesma conexão conseguia ler a observação/revisão ainda não durável. Após rollback efetivo e reabertura, ela desaparecia. O mesmo defeito foi reproduzido no journal de mensagens com recibo ambíguo.

Os dois handlers agora bloqueiam a conexão antes da tentativa de fechamento. Se até o fechamento falhar, a conexão não volta a fornecer leituras; somente uma nova instância com reabertura verificada pode recuperar o estado durável. Testes RED→GREEN e repetição independente confirmaram a correção. Não se alegou POST duplicado comprovado: o defeito observado era **falso registro/retomada durável**; no controlador, o caminho de próximo envio ainda exige CAS.

Esta correção acrescenta alterações delimitadas a `evaluations/sprint4-journal.ts` e seu teste, além dos oito arquivos novos de bootstrap. Não muda o formato do journal, não migra histórico legacy nem altera runtime `src/*`.

## Reconciliação PostgreSQL

`Sprint4BootstrapReconciler` recebe uma transação já scoped e READ ONLY. Usa uma consulta parametrizada e valida o próprio contexto de leitura. Localiza pela chave original tenant/marca/owner/request, depois confere versão/hash/modelo, snapshot recalculado, candidato/conversa, contato autorizado e canal laboratório. LEFT JOIN conserva evidência de registro incompleto; filtro prévio por versão não transforma uma criação incompatível em falsa ausência.

Avaliação exige o evento histórico exato `lab-evaluation:<id>` e seus campos. Não exige que o draft ou a membership continuem iguais depois da criação. Rota normal sem evento de avaliação não comprova publicação aprovada nem que esse marcador nunca foi removido; esse gate continua independente. Sessão e evento não podem ser futuros/incompatíveis com a leitura; o relógio da intenção precisa ser coerente com o banco. Divergência não é compensada artificialmente e exige investigação, sem recriação.

A referência `db-bootstrap:<digest>` identifica a leitura validada em memória. **Não é assinatura nem arquivo bruto arquivado**. A observação minimizada fica durável no armazenamento local, mas isso não completa o pipeline dos artefatos da resposta do modelo. Não são retornados prompt/snapshot, token ou dados de outra sessão. Nenhuma política/RLS/grant, migration, tabela remota, usuário ou segredo foi alterado.

As orientações Supabase/Postgres motivaram consulta scoped/read-only, vínculos de proprietário e preservação de privilégios. Changelog Markdown retornou tipo de conteúdo não suportado; o [changelog HTML](https://supabase.com/changelog) e a [documentação de RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) foram consultados. Não houve mudança de API/SDK ou política necessária a este recorte.

## Evidências e limites dos testes

- Orquestrador: **16/16**, 12 ciclos RED→GREEN e quatro regressões já verdes. Casos de perda de ACK local/remoto, disputa, plano/ator/target divergentes, relógio regressivo, reconciliação inválida e ausência não autorizadora.
- Store: **11/11**, oito ciclos RED→GREEN e três regressões já verdes; corrida de processos, SIGKILL e reabertura, coerência de leitura, UUIDs equivalentes e falhas SQLite. [Relatório do armazenamento](SPRINT-04-META-BOOTSTRAP-STORAGE-20260914.md).
- Journal existente: **13/13**, incluindo um novo RED→GREEN para falha conjunta de COMMIT/ROLLBACK. Histórico legacy e demais controles preservados.
- Reconciliador: **10/10 + TypeScript**, sete ciclos RED→GREEN e três regressões já verdes. Uma consulta PGlite real por leitura, com testes de pins, snapshot, vínculos, origem da sessão, tempos e contexto READ ONLY. Erro intermediário de tipagem da fixture deliberadamente inválida corrigido; não foi contado como RED funcional.
- Duas integrações novas já passaram localmente: perda de ACK após COMMIT real de criação, reabertura SQLite e reconciliação após pausa/revogação/mudança do draft; dois executores com conexões independentes criando uma só sessão.
- Nas integrações, Fastify, transações PGlite e SQLite são reais em processo. A identidade Supabase é simulada; não há socket/TLS remoto, modelo, mensagem ou gasto. A corrida dessas duas integrações é no mesmo processo; SIGKILL pertence ao teste separado do store.
- Revisão independente do orquestrador verificou também seis conflitos adversariais e as 63 execuções do plano com ports sintéticos. Isso não são 63 sessões remotas nem execuções conversacionais avaliadas.

Revisão independente final aprovada após as correções: **40/40** em bootstrap/store/journal e **12/12** em SQL/integração, 52 verificações focais (já incluídas, não somadas novamente à regressão). O relatório foi revisado sem omissão material apontada. Nenhum processo de teste/build/deploy permaneceu em execução.

### Consolidação congelada

**481/481 + TypeScript**, 74 arquivos de testes, zero falhas/skips/cancelamentos. Início `01:49:43.978`, fim `01:50:49.564 UTC`; duração dos testes `62.342,404708 ms`. [TAP integral](SPRINT-04-META-BOOTSTRAP-REGRESSAO-20260914T014943978Z.tap), [metadados e manifesto](SPRINT-04-META-BOOTSTRAP-REGRESSAO-20260914T014943978Z.json), [TypeScript](SPRINT-04-META-BOOTSTRAP-REGRESSAO-20260914T014943978Z.types.log) e [stderr](SPRINT-04-META-BOOTSTRAP-REGRESSAO-20260914T014943978Z.stderr.log) preservados. Fonte estável antes/depois; 158 hashes atuais conferidos. Frente à consolidação anterior 441/441: oito arquivos novos, somente os dois arquivos do journal alterados, 148 arquivos anteriores intactos e nenhum `src/*` modificado.

- Manifesto: `f1ebc4f8ddc3fbfa82908392980194d6f9444e37cdca68ef40ed509d72056226`.
- TAP: `2cbd28a16dc08d5088eaa156f739925dba51dde6a8937e5106f0c4f80bc103fd`.
- JSON de metadados: `d1725a28642c9ad5576d5deae6eb73f9f0816071c9f96cb54621632674f7a099`.

Nova [matriz determinística D01–D30 × 2](SPRINT-04-META-DETERMINISTICA-20260914T015126822Z.json): **60/60**, `01:51:26.822→01:51:35.775 UTC`, zero violações críticas nas assertivas, tentativas de rede e custo. Snapshot candidato permanece `c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959`; modelo fixado, não chamado. Arquivo SHA `428360d8f9f23c02fb975c07f797e5f6cdc0b2a5ea979cae8a807828f62df8a7`, manifesto `39d5c906616ae355a65e2ebef615807a308a5af21d3da969ce269ccb21e953ac`. É nova execução offline sobre este recorte, não campanha real, registro administrativo, nota humana ou medição M6.

Auditoria final independente dos artefatos, sem repetir testes: 158 fontes da regressão e 75 da determinística conferidas contra o workspace; hashes dos arquivos/manifestos, TAP/contagens, TypeScript e os 60 pares exatos D01–D30 × R1/R2 compatíveis. Nenhuma divergência. Links locais dos cinco documentos de status atualizados também conferidos, sem destino ausente.

## Continuidade necessária

O bootstrap agora compõe HTTP, persistência e recuperação de sessões. Ainda faltam composição privada de prontidão/ambiente, arquivo imutável das observações terminais e avaliação das respostas, campanha real e custo/contexto T2. Antes de enviar T2, preservar T1: o auditor confere a revisão atual da memória e pode rejeitar reauditoria de T1 após ela avançar.

O [plano fixado](SPRINT-04-META-PLANO-AVALIACAO.md) exige julgamento humano em O2 e distingue guard de qualidade em O8. Não transformar observação terminal em `objectiveAudit=passed` somente porque schema/ledger/memória mecânica passaram. Enquanto faltar evidência aplicável, manter avaliação parcial e sequência aguardando recibo; não fabricar notas ou reformular silenciosamente o gate como apenas técnico. Saída final já renderizada/reparada não é saída bruta do modelo; `financialReply` não pode ser reconstruído como se tivesse sido preservado.

Continuam pendentes administração específica autorizada de Gabriel, credencial privada fornecida por mecanismo autorizado, campanha/nota humana/publicação financeira, M6, QA autenticada/papéis, validação pessoal de João e aceite comercial. Proposta de infraestrutura não autorizada. Nenhum login para QA autoriza extração de token do navegador. Saldo e componentes remotos permanecem apenas a última fotografia documentada, não foram consultados novamente nesta etapa. **Meta ativa, não concluída.**
