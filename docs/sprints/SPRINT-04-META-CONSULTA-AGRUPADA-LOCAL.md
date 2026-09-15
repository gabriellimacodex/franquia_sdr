# Sprint 4 — protótipo da leitura de conclusão, somente local

Protótipo de 11/09/2026; atualização em 13/09: **integrado somente ao Engine local, não publicado**. Primeiro componente de uma mudança por etapas; não resolve M3 sozinho nem demonstra a meta de 5/8 segundos. As seções abaixo preservam a evidência inicial; a integração está no checkpoint final.

Arquivos novos: `src/completion-snapshot.ts`, `src/completion-snapshot.spec.ts`, `tests/completion-snapshot.test.ts`. Não entram na imagem r7.

## Hipótese delimitada

Agrupar as cinco leituras iniciais do callback (job, conversa, candidata, versão e mensagens) em um comando parametrizado. A operação permanece dentro do **mesmo `scoped` da persistência**, com advisory lock já adquirido em uma instrução anterior. Colocar a aquisição desse lock na mesma instrução das leituras alteraria o momento do snapshot MVCC; isso não foi feito.

CTEs MATERIALIZED dependentes encadeiam os row locks de job → conversa → candidata. GUCs e predicados tenant/marca são conferidos, mas a conferência de GUC **não substitui o advisory lock**. O resultado privado preserva datas e histórico da candidata, inclusive outras conversas no mesmo escopo; não é DTO público.

Estado/revisão/epoch/deadline são verificados antes de decodificar o restante. Snapshot comercial, lead state, modelo, configVersion, contratos, guard, memória, persistência e ledger continuam exigindo os checks existentes no engine após uma leitura bem-sucedida. A porta não executa escritas.

## Evidência disponível e próxima decisão

Cinco ciclos RED→GREEN, **9/9 testes e TypeScript aprovados**. Comparação com as cinco consultas originais, tipos Date/timezone, histórico multiconversa, canário de tenant estrangeiro, stale e erro privado. EXPLAIN em PGlite mostrou os três LockRows e suas dependências. Não é teste de concorrência multiconexão no PostgreSQL remoto nem medição de ganho E2E.

Revisão independente concluída por Hypatia: reproduziu 9/9, sem bloqueador encontrado no uso exigido dentro de `scoped`; teste de concorrência em PostgreSQL isolado ainda pendente. Há uma diferença temporal deliberadamente não homologada: o engine testa stale após três leituras, enquanto o protótipo já carregou versão/mensagens quando lê o relógio. O predicado e a igualdade de deadline são preservados, mas não o ponto temporal exato nem o custo do caminho rejeitado. Não alegar equivalência temporal ou ganho garantido nesses casos.

Antes de integrar, verificar essas diferenças, erros/contratos e plano real; preservar persistência/rollback e comparar o fluxo completo no harness. Não publicar como otimização avulsa apenas por reduzir cinco comandos a um: o diagnóstico exige ganho estrutural demonstrado, sem afrouxar segurança ou qualidade.

## Checkpoint de integração — 13/09

[Concorrência PostgreSQL real](SPRINT-04-META-POSTGRES-CONCORRENCIA.md): três testes com conexões independentes, papel sem bypass de RLS e dados sintéticos passaram. Um novo RED→GREEN integrou a porta apenas no laboratório; a persistência permanece na mesma transação e WhatsApp mantém o caminho anterior. Subset de integração: 41/41. Revisão independente posterior: 21/21, sem bloqueador material; erros de modelo/versão, falha SQL e deadline vencido preservaram dados/reservas nos testes adicionais. Essas contagens se sobrepõem, não devem ser somadas.

[Comparação integral simulada](SPRINT-04-META-LATENCIA-COMPLETION-20260913.json), uma amostra por atraso: com provedor fictício de 3 s, detalhe autorizado passou de 12,094 para 11,580 s; com 5,5 s, de 14,451 para 13,918 s. A conclusão reduziu quatro viagens, mas o restante do fluxo ainda domina. Auth/ACK são artificiais zero e não há navegador/renderização: não são medições M6 nem previsão garantida do ambiente real.

**Decisão: não publicar essa mudança isoladamente como solução de latência.** Continuar a integração estrutural de preparo/reserva, com novo benchmark do conjunto. R7 permanece o último runtime publicado; nenhuma chamada paga foi feita nesta comparação.
