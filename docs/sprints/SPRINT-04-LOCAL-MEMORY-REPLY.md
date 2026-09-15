# Sprint 4 — S4.09: resposta independente na correção de memória

Estado: **IMPLEMENTADA E VERIFICADA LOCALMENTE — 11/09/2026**. Após “Vamos em frente”, a rodada trata a preservação de respostas durante o aviso de conflito. Não houve publicação, consulta ao ambiente remoto do projeto ou chamada paga; o sprint não foi encerrado.

**Atualização posterior:** o [gate remoto S4.09](SPRINT-04-MEMORY-GATE-20260911.md) foi autorizado e executado em seguida, publicando somente o reparo na API/worker r4. Este documento preserva o histórico da etapa local; afirmações abaixo sobre publicação/saldo pendentes referem-se àquela etapa. A QA posterior respondeu quem opera/decide junto do aviso de conflito; latência de 18,625/14,984 s ainda reprovada frente à meta aceita de 5 s típicos/até 8 s na bateria.

## Problema e escopo

A reprodução local anterior mostrou que `reconcileMemoryReply` substituía integralmente o primeiro balão diante de um novo conflito, inclusive quando continha uma resposta factual independente correta. A [QA S4.08](SPRINT-04-WAITS-GATE-20260911.md) observou a omissão sobre quem opera/decide, mas a saída bruta não está disponível: o comportamento local é uma hipótese compatível, **não a causa comprovada daquela execução remota**.

A mudança fica em `src/memory-reply.ts`:

- Preserva a resposta independente no primeiro balão.
- Usa `Intl.Segmenter` com `pt-BR` para retirar frases completas reconhecidas como confirmação de atualização/aplicação e manter literalmente as frases independentes, junto do aviso honesto de conflito. Não tenta extrair cláusulas por vírgula.
- Respeita o limite de **dois balões de até 600 caracteres**. Tenta combinar o conteúdo antes de omitir um balão posterior inteiro; não corta caracteres, valores ou negações para caber.
- Mantém o fallback conservador quando não existe separação segura entre a afirmação falsa e a resposta independente.

Nenhum novo guard, prompt, modelo, schema, workflow n8n, frontend ou contrato financeiro foi introduzido. Fatos, evidências, conflito e revisão humana não são liberados por esse reparo de apresentação.

## TDD e verificação final

Os testes unitários passaram **15/15**. O histórico registra sete ciclos RED → GREEN unitários, um caso por vez:

1. Resposta independente no primeiro balão.
2. Overflow dos limites de saída.
3. Combinação de conteúdo de dois balões.
4. Confirmação falsa e resposta independente no mesmo balão.
5. Idempotência do reparo.
6. Aviso de conflito duplicado.
7. Confirmação dependente de aplicação que escapava após retirar a primeira frase.

Três regressões adicionais passaram: **260.000,50 e negação** intactos; “não foi aplicada” preservado junto da retirada de uma afirmação positiva posterior; e confirmação inseparável por vírgula mantendo o fallback conservador. Dez unitários e um teste de integração foram acrescentados; testes preexistentes não foram reescritos para acomodar a implementação.

A integração também teve RED → GREEN: um loader temporário carregou o reparador antigo somente naquele processo, sem trocar o `src` compartilhado, e a asserção da resposta Marina/Caio falhou. Com a implementação atual, **2/2 testes de integração** passaram. O novo caso usa quatro fatos e uma relação fictícios, confirma resposta no histórico/job, mantém timestamps/evidências/propostas/relação e a nova cidade em `conflict`, rejeita replay sem duplicar mensagens e mantém zero deliveries. Os dois turnos usam transporte injetado fictício, sem provedor real.

| Verificação | Estado |
| --- | --- |
| Unitários / integração de memória | 15/15 + 2/2 aprovados |
| Suíte completa e TypeScript | **193/193 + TypeScript aprovados**; `npm run build && node --import tsx --test --test-concurrency=4 tests/*.test.ts`, Node v24.13.1; 43,156 s de suíte, não benchmark do produto |
| Revisão independente | Encontrou a confirmação dependente, corrigida por novo RED → GREEN; sem novo bloqueador concreto nos casos reavaliados |
| Publicação e QA remota | Fora do escopo desta rodada |

Único aviso de execução observado: depreciação preexistente de `disableRequestLogging` do Fastify; nenhuma dependência foi alterada. A suíte inclui o financeiro v2 já existente na árvore local, sem publicá-lo. Código alterado somente em `src/memory-reply.ts`; testes em `tests/memory-reply.test.ts` e `tests/engine-memory-reply.test.ts`. TDD e revisão independente orientaram as bordas; as orientações Supabase/Postgres preservaram escopo e privilégios nos testes, sem migração ou acesso ao banco remoto. Consultou-se apenas documentação pública do provedor, sem mudanças aplicáveis a este recorte.

## Limites e próximo fechamento

O reconhecimento usa formas finitas; não promete compreender qualquer paráfrase ou todo escopo de negação. Frases não reconhecidas ainda exigem avaliação. Se a resposta estiver na mesma frase da confirmação indevida, a frase inteira continua descartada. Se aviso e os dois balões não couberem em 2×600 caracteres, o conteúdo posterior pode ser omitido integralmente para preservar o aviso e a resposta anterior; não há garantia de retenção integral de entradas que já ocupam 1.200 caracteres. Não interpretar preservação de texto como confirmação humana de fato conflitante.

S4.09 está concluída **localmente**, nos cenários reproduzidos; a correção ainda não está no site. Nenhum aceite comercial geral, de fluidez ou de comportamento publicado foi declarado. A meta numérica de tempo foi perguntada ao usuário e segue sem definição nesta rodada.

A última referência remota é **histórica**, do gate S4.08: API/worker r3, site v8 e 300.907 microUSD utilizados. **Não foi reconsultada nesta rodada** e não representa saldo ou saúde atuais garantidos. Publicar esse reparo ou executar nova chamada paga exige o gate correspondente; nenhuma autorização adicional é inferida aqui.
