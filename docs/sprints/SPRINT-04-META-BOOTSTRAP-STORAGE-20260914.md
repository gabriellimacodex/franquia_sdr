# Sprint 4 — armazenamento privado do bootstrap, somente local

14/09/2026 UTC. **Código local; nenhuma publicação, credencial real, requisição remota ou chamada paga.** Esta entrega não aprova criação remota nem torna a campanha inteira pronta para execução.

## Recorte

`Sprint4BootstrapStorage` implementa o `BootstrapStorageSpec` já definido pelo responsável principal, sem alterá-lo. Foram criados apenas:

- `evaluations/sprint4-bootstrap-storage.ts`;
- `tests/sprint4-bootstrap-storage.test.ts`;
- este relatório.

O journal de campanha existente, seus arquivos/formatos, os contratos de bootstrap, o orquestrador e o runtime não foram modificados por esta subtarefa.

O construtor recebe `{ directory, initializeNew?: boolean }`, sem valores de ambiente nem diretório padrão. `initializeNew` é falso por padrão; criação explícita só aceita diretório privado vazio. Reabrir arquivo ausente não cria outro. Um arquivo existente nunca é migrado, truncado ou reinicializado.

## Garantias implementadas

- Diretório POSIX existente, absoluto, de proprietário igual ao processo, com modo `0700`. Apenas `sprint4-bootstrap.sqlite` e o journal transacional `-journal` são admitidos; arquivos regulares `0600`, sem symlink ou hardlink. Revalidação em cada operação e comparação de dispositivo/inode impedem seguir silenciosamente um arquivo substituído.
- SQLite próprio, `application_id=0x53423431`, `user_version=1`, formato verificado antes de configurar uma base reaberta. `DELETE`, `synchronous=EXTRA`, `fullfsync=ON`, foreign keys e espera de lock limitada a cinco segundos. A criação usa `O_EXCL/O_NOFOLLOW`, fsync do arquivo e, após inicialização, do diretório.
- `claim-once` e `record-session-once` executam sob `BEGIN IMMEDIATE`. Sucesso só é retornado após `COMMIT`; erros provocam rollback, sem transformar falha em estado vazio. A espera do lock não é uma retentativa de POST.
- Se o rollback também falhar, o handle fica em quarentena antes da tentativa de fechamento. A mesma instância não pode ler dados possivelmente não duráveis, gravar ou reinicializar automaticamente; permanece bloqueada mesmo se fechar a conexão falhar. Reabertura explícita por outra instância exige as verificações normais do arquivo, sem reset.
- As três tabelas locais recebem somente INSERT pelo adaptador. O mesmo run fixa hash do plano, ator e target. ExecutionId/requestId são únicos no arquivo; sessionId/candidateId não podem pertencer a outra execução. UUIDs usam comparação de unicidade sem distinção de caixa, preservando o JSON original.
- Comparação exata usa valores parseados pelo schema; hash da intenção é `SHA256(JSON.stringify(BootstrapIntentSchema.parse(value)))`, sem coerção ou reordenação arbitrária adicional. Replay de intenção idêntica retorna `claimed:false`; intenção divergente retorna `STATE_CONFLICT`.
- Uma observação só é anexada à intenção correspondente, com hash correto, data não anterior à intenção e versão/rótulo/cenário iguais. Replay exato retorna `duplicate:true`; observação diferente não substitui a anterior. Não existe estado de falha ambígua que consuma a única vaga de confirmação.
- A leitura reúne intenção, binding do run e observação em um único SELECT, incluindo detecção de observação órfã. Assim não confunde uma inserção concorrente entre consultas com corrupção.

`read` de uma execução existente com run diferente devolve conflito, sem retornar seu conteúdo. Erros são códigos do contrato, sem mensagens internas de SQLite ou conteúdo privado.

## Retomada e limites

Uma intenção já gravada nunca volta a autorizar criação. Se houve interrupção após o COMMIT da intenção e antes de guardar o resultado, a leitura encontra intenção sem observação: o orquestrador precisa reconciliar somente leitura o mesmo pedido. Nem ausência de observação nem um erro de transporte autoriza novo POST.

Disputa legítima com requestIds/datas diferentes produz um vencedor e `STATE_CONFLICT` no outro processo. Cabe ao orquestrador reler e validar a intenção vencedora, sem substituí-la. O armazenamento não elege outro pedido para tentar novamente.

A observação é somente uma confirmação vinculada, fornecida pelo chamador. O campo `source` não prova identidade, autoria HTTP ou execução da consulta de reconciliação. O storage não recebe plano completo para revalidar a matriz, não autentica usuário, não verifica realidade dos pins externos e não infere que a sessão está apta a processamento pago. Essas verificações permanecem nos componentes próprios.

A unicidade é limitada a este arquivo privado. Um operador que duplique ou apague o diretório pode romper a continuidade; não há proteção contra adulteração pelo mesmo UID, administrador privilegiado ou rollback externo do filesystem. Não existe API para esse reset. As provas de durabilidade cobrem processos e transações locais, não desligamento físico, falha de hardware ou filesystem hostil.

## Evidência

Oito ciclos RED→GREEN observados, um teste por etapa:

1. Módulo ausente → intenção durável, reabertura e replay sem segunda liberação.
2. Replay alterado aceito → imutabilidade de intenção, binding do run e unicidade de pedidos.
3. Registro de observação não implementado → anexação única, reabertura e replay exato.
4. Confirmação sem vínculo aceita → hash/data/versão/rótulo/cenário e unicidade sessão/candidato.
5. Diretório permissivo aceito → permissões, links, conteúdo exclusivo e identidade do arquivo.
6. Duas conexões reais, com escrita intercalada, causavam falso `CORRUPT_STATE` → leitura por snapshot de um SELECT; a leitura seguinte observa o registro completo.
7. UUID com caixa diferente liberava uma segunda intenção → `COLLATE NOCASE` nos três identificadores UUID, sem alterar os hashes/JSON.
8. Falhas injetadas de COMMIT e ROLLBACK deixavam a conexão devolver uma observação não durável → quarentena imediata do handle e tentativa de fechamento, sem reutilização automática. O teste exige falha de read/claim/record posteriores e confirma intenção sem observação após reabertura explícita.

Três regressões adicionais já verdes, sem alegar um RED artificial:

- Base ausente/estrangeira/corrompida não vira ausência válida; rejeitar formato estrangeiro mantém seus bytes.
- Dois processos Node reais disputam uma execução sob contenção SQLite, com requestIds distintos: um único vencedor. Ambos recebem SIGKILL após os resultados; um terceiro processo recupera a intenção vencedora e obtém `claimed:false` no replay. Há exatamente uma intenção, um run e nenhuma observação fabricada.
- Triggers apenas da fixture forçam erro SQLite nas duas gravações. A intenção falhada não deixa run parcial; a confirmação falhada preserva a intenção e mantém observação ausente. PRAGMAs de durabilidade são conferidos, e erros não expõem a mensagem da fixture.

```sh
node --import tsx --test tests/sprint4-bootstrap-storage.test.ts
```

Último resultado: **11/11**, zero falhas/skips/cancelamentos/todo; duração total `991,009083 ms`. Node local `v24.13.1`, com o aviso experimental esperado de `node:sqlite`. A suíte completa compartilhada não foi executada por esta subtarefa.

A execução local de `npm run build` reportou apenas o erro concorrente `tests/sprint4-bootstrap-reconcile.test.ts:124:138` (model inferido como string, em arquivo de outro responsável). Nenhum erro foi reportado nos arquivos deste storage nessa execução; a consolidada final fica com o responsável principal.

## SHA-256 no freeze

| Arquivo | SHA-256 |
| --- | --- |
| `evaluations/sprint4-bootstrap-storage.ts` | `52bade6d5524ad598ea2b6467a870903c32ad87e2c229436f91c125a48251884` |
| `tests/sprint4-bootstrap-storage.test.ts` | `35cc98066b187dfdb0fad872775b37333cbf75eee09a56138cd2a8d1f0e6362b` |

TDD e contratos tipados orientaram as falhas reproduzidas, os resultados explícitos e a comparação canônica; a revisão focada manteve o recorte independente do journal e do runtime. Não há migração remota, mudança de gate/modelo/cota, aprovação humana ou garantia de conclusão do sprint nesta entrega.
