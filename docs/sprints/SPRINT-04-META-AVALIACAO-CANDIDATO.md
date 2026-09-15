# Meta Sprint 4 — avaliação privada de rascunho

Implementada e revisada em 11/09/2026; incluída na [r7 publicada em 13/09](SPRINT-04-META-RUNTIME-V2-PUBLICACAO.md), posterior ao pacote M2. Negativa anônima remota 401 confirmada. **Não houve criação/avaliação real de candidato nem validação positiva com admin**, pois a autorização específica de membership continua pendente.

## Lacuna resolvida no código

As sessões comuns continuam fixadas à versão ativa. A nova rota `POST /v1/lab/evaluation-sessions`, disponível apenas em modo `laboratory`, permite ao administrador criar uma sessão própria vinculada ao rascunho exato antes da publicação. Assim, avaliar não exige trocar a versão ativa ou ignorar o gate de qualidade.

Entrada estrita: `requestId` UUID, `label`, `scenario` (`free`, `investment`, `correction`, `human`), `versionId` e `contentHash` SHA-256. Usa a autenticação e a seleção de tenant/marca existentes. Não aceita snapshot, modelo ou proprietário enviados arbitrariamente pelo cliente.

## Controles preservados

- Membership administrativa ativa é verificada no banco dentro da transação e lock de marca; o campo `role` do objeto do chamador não concede autoridade.
- Versão e hash precisam corresponder ao rascunho atual, à versão imutável e a ambos os snapshots válidos no mesmo escopo.
- A criação não altera `active_versions`, não produz `publication_events` ou relatórios, nem cria jobs/reservas. Não habilita canais.
- Um evento privado `lab_evaluation_session_created` registra origem, proprietário, requestId, versão e hash na mesma transação. Usa a tabela existente; nenhuma migration ou grant novo.
- Novas mensagens de uma sessão marcada exigem novamente admin real ativo. Downgrade/revogação impede novos envios; a verificação ocorre antes de mensagens ou jobs serem gravados.
- O mesmo requestId não pode mudar de versão ou transitar entre criação normal e avaliação. Replay equivalente retorna a mesma sessão, desde que o rascunho solicitado continue válido.
- Sessões normais históricas permanecem retomáveis na versão original; versão inativa não é usada como indício de avaliação privada.
- DTOs de criação/detalhe não expõem o marcador ou metadados internos. Mensagens seguem o fluxo já existente de worker, guard, versão fixada e ledger; esta rota não fornece um caminho de chamada direta ao modelo.
- Erros de contrato: 400; acesso: 403; rascunho/hash ou replay conflitantes: 409. Fora do laboratório: 403 `EVALUATION_LAB_ONLY`.

## Evidências locais

Arquivos: `src/lab-sessions.ts`, `src/server.ts`, `tests/lab-evaluation-sessions.test.ts`.

Seis ciclos RED → GREEN: rota inexistente, colisão de requestId entre versões, bloqueio fora do laboratório, envio após downgrade, replay cruzado e status de contrato inválido. Mais duas regressões de membership real e vínculo exato com rascunho/hash/contrato estrito.

Oito testes específicos aprovados. TypeScript aprovado. Suíte compartilhada completa após congelamento: **228/228**, 38,963068542 s, Node 24.13.1, quatro processos de teste. Revisão independente reproduziu 409 no replay cruzado, 403 após downgrade, ausência de metadados nos DTOs e funcionamento da sessão comum histórica após troca de versão/downgrade.

Todos os testes usam banco efêmero e respostas simuladas. **Não são validação conversacional medida do modelo nem notas humanas.**

## Trabalho ainda necessário

Cadastro administrativo explicitamente autorizado, validação positiva da rota publicada, rascunho real via processo existente, runner e matriz prévia, reserva/saldo conferidos, campanha medida 30×2 e avaliação humana. Esta rota apenas cria a sessão: não completa esses gates, não autoriza gasto adicional e não substitui a bateria final de latência.
