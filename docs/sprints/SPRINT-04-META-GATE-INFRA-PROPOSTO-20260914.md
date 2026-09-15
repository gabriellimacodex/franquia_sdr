# Sprint 4 — proposta de teste de proximidade, não autorizada

14/09/2026 UTC, preços conferidos às 00:37. **Não há autorização para criar recursos, gasto de infraestrutura, migração, DNS ou novos acessos.** Esta proposta torna acionável a dependência de [latência da r8](SPRINT-04-META-LATENCIA-LIMITE-R8-20260914.md); não muda a definição de conclusão do sprint.

## Opção e custo

Uma instância AWS Lightsail Linux com IPv4 público em **Ohio (`us-east-2`)**, mesma região declarada do Supabase existente. A região consta na documentação; disponibilidade/capacidade da conta ainda não foram verificadas. [Regiões oficiais](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html)

Plano proposto: **2 GB, 2 vCPU, SSD de 60 GB e transferência de 3 TB**, US$ 12/mês; tarifa regional US$ 0,01612/h, aproximadamente **US$ 0,77376 por 48 horas de computação**. Preferência por margem operacional, não capacidade ou latência comprovadas. Não contar créditos ou gratuidade. [Tabela oficial](https://aws.amazon.com/lightsail/pricing/), [catálogo regional AWS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonLightsail/current/us-east-2/index.json)

**Orçamento novo proposto: até US$ 2 antes de impostos, por no máximo 48 horas**, separado do teto do modelo. É controle operacional, não bloqueio automático da cobrança. A aprovação deve incluir remoção da instância e de eventual IP exclusivo do teste ao terminar; uma instância parada continua sendo cobrada. IP estático desanexado por mais de uma hora também pode cobrar. [Regras de cobrança](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html)

Se não for possível assegurar acesso, acompanhamento e exclusão dentro da janela/cota, não iniciar. Não criar load balancer, snapshots, disco adicional, banco, DNS ou outros serviços pagos. Transferência externa não deve ser presumida gratuita por coincidência regional; observar consumo e interromper antes do teto.

## Gate 1 — teste isolado, sem trocar o ambiente

Após autorização explícita e acesso à conta do usuário:

1. Confirmar conta/região/plano e preço vigente antes de contratar. Não abrir conta ou aceitar cobrança mais ampla por inferência.
2. Criar somente recurso identificado para este teste, acesso restrito e arquitetura compatível com a imagem fixada. Nenhum usuário público ou novo recurso compartilhado.
3. Usar imagem/driver fixados para medir TLS e consultas somente leitura ao mesmo session pooler. Transferir apenas os segredos indispensáveis por canal seguro, sem imprimi-los. Não copiar banco ou histórico.
4. **Worker novo desligado**, sem consumir fila, sem POST n8n/modelo, sem nova API pública. VPS, DNS, frontend, n8n, canais, schema, Auth/RLS/memberships e gate do modelo intactos.
5. Registrar RTT, condições, limites e custos. Medidas de rede não são aceite de M6.
6. Preservar evidências e excluir somente os recursos exclusivos criados para este teste dentro da janela aprovada; conferir cobrança residual. Não remover a VPS, banco, imagem ou rollback atuais.

## Gate 2 — migração operacional, não incluída no teste

Só propor depois de evidência favorável e nova autorização específica: compatibilidade, custos continuados, acesso público/TLS/DNS, auditoria/drenagem de jobs/reservas, parada exclusiva do worker SDR antigo e ativação do novo sem coexistência. Preservar n8n e todos os demais serviços da VPS, com plano de voltar imagem/configuração e registro A anteriores. Não trocar nameservers ou apagar a VPS.

Mesmo um RTT menor não garante mediana ≤5 s/todos ≤8 s. n8n/modelo, autenticação e navegador permanecem no caminho; a bateria M6 e os aceites humanos continuam obrigatórios. Nenhum recurso foi contratado ou alterado durante esta pesquisa.
