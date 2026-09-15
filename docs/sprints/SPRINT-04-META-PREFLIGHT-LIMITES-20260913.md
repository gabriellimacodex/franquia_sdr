# Sprint 4 — limites verificados do controlador pré-envio

Inspeção local de 13/09/2026. **Campanha paga não liberada.** Nenhuma chamada, permissão, schema ou configuração remota foi alterada por esta análise. A bateria determinística não elimina estes impedimentos de execução da campanha conversacional.

Atualização em 14/09 às 00:29 UTC: o risco de retry descrito na seção 2 foi corrigido e [publicado na r8](SPRINT-04-META-RECUPERACAO-20260914.md), com 284/284 testes na imagem e auditoria pós-deploy. Reserva existente impede novo POST, mesmo em outro attempt/gate. Falha anterior à primeira reserva pode recuperar; o auditor local foi ajustado para uma única reserva vinculada ao attempt efetivo, 14/14 + TypeScript, ainda fora da imagem. A separação de admissão/preparo da seção 1 continua pendente de integração; não inferir campanha paga liberada. As seções abaixo preservam o diagnóstico original.

## 1. Prontidão não é medição do payload futuro

O `PreflightSchema` em `evaluations/sprint4-controller.spec.ts` exige sessão existente, `deadlineAtMs`, `exactPayloadBound` e reserva correspondente. A auditoria em `sprint4-terminal-audit.ts` exige igualdade desses valores com o ledger terminal.

Entretanto:

- `LabSessions.send` cria o job/ID e deadline durante o envio; o job `pending` já fica disponível ao worker.
- `Engine.prepare` prepara o contexto e grava `jobs.context`: não é leitura nem preview.
- `LaboratoryDispatch` prepara contexto e reserva na mesma transação, antes do transporte. É o ponto local em que o payload efetivo pode ser medido.
- O medidor T1 offline usa jobs fictícios. Seus resultados não comprovam histórico, revisão, índices, validade temporal das fontes, ID ou deadline de um futuro envio real. T2 permanece dependente do T1 real.

Portanto não conectar um adapter que preencha `exactPayloadBound` com estimativa e a apresente como medição. Também não apenas relaxar a igualdade na auditoria para fazer o controlador passar.

A próxima implementação precisa separar: (a) prontidão/autorização administrativa, saldo e capacidade antes de enviar; (b) preparo efetivo e reserva vinculada ao turno, atomicamente antes do transporte; (c) auditoria do payload/reserva reais e do resultado. Uma estimativa ou teto aprovado deve ser identificado como tal e fiscalizado em runtime, não convertido em evidência retrospectiva. A forma de vincular esses pontos ainda precisa de contrato e testes; este documento não a declara implementada.

## 2. `dispatch-once` local não garante ausência de retry no worker

O controlador não entrega novamente a mesma intenção ao seu chamador. Isso não cobre o worker:

- `src/worker.ts` recoloca `working` em `pending` após falha/timeout de dispatch.
- `Store.claim` incrementa `attempts` ao recuperar um job pendente ou com lease vencido.
- A reserva financeira é por job e tentativa. Uma tentativa posterior pode criar outra reserva; o teto agregado continua protegido.

Quando o provedor recebeu a primeira requisição mas o ACK se perdeu, é necessário tratar a tentativa como ambígua. Não afirmar que a campanha de 66 turnos garante 66 chamadas apenas porque o controlador usa intenção durável. A análise de código identifica a possibilidade; não houve teste pago de duplicação e não se afirma que ela ocorreu em produção.

Antes da campanha: provar o comportamento ponta a ponta sob ACK perdido, lease vencido, callback antecipado/tardio, replay e deadline, preservando contabilidade conservadora e sem retries pagos automáticos não planejados. Não usar a cota global como substituto dessa garantia.

## 3. O que a matriz determinística comprova e não comprova

D29 cobre repetição de POST/callback e rejeição de resultado antigo, usando dois dispatches simulados explicitamente contados. Não executa o laço do worker nem comprova a ausência de retry após ACK perdido. D30 cobre rollback e conservação da reserva em falhas de conclusão/liquidação. Esses resultados são úteis, mas distintos da garantia operacional acima.

## Próxima retomada

Concluir e arquivar a matriz determinística; em seguida implementar a separação prontidão/preparo com TDD e provas de tentativa ambígua antes de conectar envios reais. Manter a campanha paga fechada, o mesmo gate/cota/modelo e todas as dependências administrativas/humanas. A autorização específica de membership, novo login, notas de João e aceite de Gabriel continuam necessários; não são substituídos por este diagnóstico.
