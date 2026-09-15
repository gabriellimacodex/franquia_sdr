# Prompt de execução — Sprint 3

Copie o conteúdo abaixo para iniciar o próximo sprint.

---

Você é o agente responsável pelo **Sprint 3 do laboratório SDR Sapore**. Trabalhe de forma autônoma, incremental e auditável até concluir o objetivo ou encontrar um gate que exija ação humana explícita.

## Objetivo do sprint

Concluir a **homologação humana do ambiente publicado**, comprovando autenticação real, autorização por papel, isolamento de dados, retomada da sessão persistida e qualidade visual em desktop e mobile, sem reativar o worker, sem publicar o workflow n8n e sem realizar novas chamadas pagas ao modelo.

O Sprint 2 já concluiu a infraestrutura e uma execução real controlada. **Não repita trabalho concluído e não crie uma nova arquitetura.** Use os artefatos existentes e concentre-se nas pendências E2E.

## Estado inicial autoritativo

- Supabase: projeto `xxvfuyydhfijhudtytsk`.
- Escopo: tenant `cognita-homologacao`, marca `sapore`.
- Cadastro público desabilitado e previamente verificado com `disable_signup=true`.
- Usuários autorizados:
  - `gabriel.lima@cognitaai.com.br` — papel `tester`, convite confirmado na última verificação.
  - `joao.lucas@cognitaai.com.br` — papel `reviewer`, convite ainda aguardava confirmação na última verificação; revalidar antes de concluir.
- As duas memberships estão ativas.
- API publicada: `https://sdr-api.cognitaai.com.br`.
- Frontend publicado: `https://borelli-expansao.ana-mendes.chatgpt.site`.
- n8n: `https://sdr-n8n.cognitaai.com.br`.
- Workflow exclusivo: ID `SaporeAsyncV1Lab`, nome `Sapore SDR — async reasoning v1`, atualmente inativo/despublicado.
- Worker `sapore-sdr-worker-1` parado com saída 0.
- WhatsApp, Kapso, outbound e retenção continuam desativados.
- Modelo da execução anterior: `gpt-5.4-2026-03-05`.
- O gate financeiro anterior de R$ 2,00 foi consumido e encerrado após uma única chamada. **Não existe saldo reutilizável nem autorização implícita para outra chamada.**
- Sessão fictícia persistida:
  - rótulo: `Ana Teste — Sprint 2`;
  - conversation ID: `2e32025d-1af8-4e4b-b8bf-45cccc365951`;
  - job ID: `lab-af971d69ef4427ea93b505cabe78dc63:6c0a4559-45a7-4705-80d6-f0755ac17ff4`;
  - proprietária: conta tester de Gabriel;
  - resultado esperado: duas mensagens do agente, três fatos com evidência, uma fonte, um evento, uso de 1.884 tokens de entrada e 463 de saída, latência de 19.059 ms e zero deliveries.

## Leia antes de agir

Use estes documentos como fonte de verdade e atualize-os apenas com evidências novas:

1. `sapore-sdr/docs/sprints/SPRINT-02.md`
2. `sapore-sdr/docs/sprints/SPRINT-02-REMOTE-GATE.md`
3. `sapore-sdr/docs/implementation-status.md`
4. `sapore-sdr/docs/lab-access-audit-20260910.md`
5. README e instruções locais aplicáveis nos diretórios envolvidos.

Inspecione também o estado atual do repositório antes de editar. Preserve alterações do usuário e serviços não relacionados.

## Invariantes de segurança

- Não solicite, exiba, registre ou versione senhas, tokens, cookies, API keys, URLs com segredos ou conteúdo de arquivos secretos.
- Quando uma senha ou confirmação por e-mail for necessária, peça ao próprio usuário para agir na interface e continue com as demais verificações seguras.
- Não habilite cadastro público.
- Não crie novos usuários ou memberships sem autorização nominal.
- Não inicie o worker e não publique/ative o workflow n8n durante este sprint.
- Não chame OpenAI ou qualquer outro modelo. Não execute novamente o job existente.
- Não habilite WhatsApp, Kapso, canais, outbound ou envio de mensagens.
- Não altere nem reinicie CRM, Caddy global, workflows preexistentes ou outros serviços da VPS.
- Não apague sessões, jobs, mensagens, fatos, eventos, logs ou evidências.
- Toda verificação de negação deve ser não destrutiva e não pode tentar contornar autenticação ou autorização.
- Se o estado remoto divergir da documentação, pare a ação mutável, registre a divergência e investigue primeiro por leitura.

## Micro-metas

Execute na ordem abaixo. Cada micro-meta deve terminar com: estado, evidência, risco residual e próximo passo.

### S3.01 — Baseline e invariantes

1. Verifique o estado local e leia a documentação autoritativa.
2. Rode as suítes relevantes do backend e frontend, além de typecheck, lint e build, sem ampliar o escopo de correções.
3. Revalide por leitura:
   - API `/health` e `/ready` em HTTP 200;
   - modo `laboratory`;
   - worker parado;
   - workflow `SaporeAsyncV1Lab` inativo/despublicado;
   - webhook do workflow indisponível enquanto inativo;
   - cadastro público desabilitado;
   - zero canais habilitados e zero deliveries;
   - exatamente as memberships autorizadas no escopo do piloto.
4. Se algum invariante crítico falhar, não avance para o E2E. Documente o bloqueio e proponha o menor rollback seguro.

Critério de aceite: baseline verde e nenhuma ativação ou gasto provocado pela verificação.

### S3.02 — Contas e autenticação real

1. Revalide o estado de confirmação dos dois usuários.
2. Se João ainda não tiver confirmado o convite, trate isso como gate humano e forneça somente a instrução necessária para ele concluir o cadastro.
3. Com cada pessoa em sua própria sessão de navegador, validar:
   - acesso externo do Site;
   - login Supabase no frontend;
   - renovação de sessão, quando aplicável;
   - logout;
   - negação após logout;
   - novo login sem perda do contexto permitido.
4. Não digite nem capture as senhas dos usuários.

Critério de aceite: Gabriel e João entram e saem com suas próprias contas, e uma sessão encerrada não continua autorizando chamadas.

### S3.03 — Matriz de autorização e isolamento

Comprove a matriz abaixo usando a API e o frontend publicados:

| Ator | Resultado esperado |
| --- | --- |
| Gabriel, `tester` | Lista e abre somente as sessões que lhe pertencem; consegue retomar `Ana Teste — Sprint 2`. |
| Outro tester autorizado, se existir futuramente | Não vê nem abre a sessão de Gabriel. Não crie esse usuário neste sprint. |
| João, `reviewer` | Acessa somente as visões e dados previstos para revisão no escopo autorizado. |
| Gabriel em endpoint exclusivo de reviewer | Acesso negado sem vazamento de conteúdo. |
| Usuário autenticado sem membership | Acesso negado. Use apenas uma identidade já existente e legitimamente disponível; não crie conta para o teste. Se não houver, marque o caso como pendente, sem simular evidência. |
| Visitante não autenticado | Não acessa dados do laboratório. |

Registre status HTTP e comportamento visível, mas remova tokens, cookies e dados sensíveis das evidências.

Critério de aceite: nenhum ator lê dados acima do seu escopo e as negações não revelam a existência ou o conteúdo de sessões privadas.

### S3.04 — Retomada da sessão persistida

1. Pela conta tester de Gabriel, localizar `Ana Teste — Sprint 2` no frontend publicado.
2. Confirmar, sem novo envio ao modelo:
   - histórico existente;
   - duas mensagens do agente;
   - fatos e respectivas evidências;
   - fonte utilizada;
   - estado final do job;
   - tokens e latência persistidos;
   - ausência de deliveries.
3. Recarregar a página e confirmar que o estado permanece.
4. Fazer logout, entrar novamente e confirmar que a mesma sessão e histórico reaparecem.
5. Verificar que nenhum botão ou ação dispara acidentalmente o job anterior.

Critério de aceite: o contexto persiste após reload e nova autenticação e permanece restrito ao escopo correto.

### S3.05 — Homologação visual publicada

Validar as telas reais autenticadas, no mínimo, em:

- desktop: `1440 × 900`;
- mobile: `390 × 844`.

Verificar login, lista de sessões, histórico, composer, dossiê, escopo, fatos/fontes, tokens, latência, estados de erro e logout. Confirmar legibilidade, foco por teclado, ausência de overflow horizontal e mensagens compreensíveis de carregamento, vazio, negação e falha.

Faça apenas correções cirúrgicas que estejam diretamente ligadas a falhas observadas. Para cada correção: reproduza, acrescente ou ajuste teste, implemente, rode a suíte e valide novamente no ambiente aplicável. Não redesenhe o produto.

Critério de aceite: fluxo publicado utilizável nas duas larguras, sem quebra funcional ou exposição de dados internos.

### S3.06 — Revisão humana da execução existente

Sem chamar o modelo novamente, avaliar as respostas já persistidas quanto a:

- aderência ao tom Sapore;
- clareza e naturalidade;
- uso correto da faixa de investimento aprovada;
- preservação de incerteza onde a fonte não detalha composição de valores;
- ausência de promessa, aprovação financeira ou dado inventado;
- coerência dos fatos extraídos com suas evidências;
- adequação do próximo passo sugerido.

Registrar a avaliação como evidência de um único cenário. Não generalizar a qualidade do agente para os outros 14 cenários ainda não executados.

Critério de aceite: parecer humano objetivo, com itens aprovados, falhas observadas e recomendação para a próxima rodada de avaliação.

### S3.07 — Gate opcional para novas chamadas

Esta micro-meta começa **bloqueada**. Não a execute durante o Sprint 3 padrão.

Só prossiga se o usuário emitir uma nova autorização explícita contendo, no mesmo gate:

- modelo exato autorizado;
- número máximo de chamadas;
- teto financeiro total e moeda;
- cenários autorizados;
- confirmação de que continuam fictícios e sem envio externo.

Antes de gastar, apresente a estimativa conservadora de custo e o mecanismo de corte. Pare ao atingir qualquer um dos limites. Nunca reutilize o teto de R$ 2,00 do Sprint 2.

### S3.08 — Evidências, rollback e handoff

1. Criar ou atualizar o documento do Sprint 3 com:
   - data e ambiente;
   - matriz de aceite;
   - evidências sanitizadas;
   - testes executados e resultados;
   - mudanças realizadas;
   - divergências e riscos;
   - gastos, que devem ser zero neste sprint padrão;
   - comprovação de zero novas chamadas e zero deliveries;
   - estado final dos invariantes.
2. Atualizar `implementation-status.md` apenas com fatos comprovados.
3. Entregar um resumo executivo curto e uma lista objetiva das pendências.
4. Encerrar mantendo:
   - API saudável;
   - worker parado;
   - workflow n8n inativo/despublicado;
   - cadastro público desabilitado;
   - canais, WhatsApp, Kapso e outbound desativados;
   - histórico preservado.

## Regras de autonomia

- Prossiga sem pedir confirmação para inspeções somente leitura, testes locais, documentação e correções locais reversíveis dentro do escopo.
- Não pare apenas porque uma verificação pode ser feita de outra forma; escolha a opção mais segura e com melhor evidência.
- Peça ação humana somente quando houver credencial pessoal, confirmação de convite, decisão de produto, alteração remota relevante ou novo gasto.
- Um gate humano não bloqueia as micro-metas independentes. Avance nelas e retorne ao gate depois.
- Não declare aprovação com base em fixture local quando o critério exige ambiente remoto.
- Não marque como concluído um teste que não pôde ser executado; use `pendente` ou `bloqueado`, com a causa exata.
- Preserve o escopo: este sprint não ativa operação comercial, WhatsApp, Kapso, worker contínuo nem candidatos reais.

## Definition of Done

O Sprint 3 só pode ser declarado concluído quando:

- os dois usuários autorizados concluíram login e logout reais;
- o cadastro público permanece desabilitado;
- a matriz tester/reviewer foi comprovada no ambiente publicado;
- visitante, usuário deslogado e identidade sem autorização não recebem dados privados, ou o único caso impossível foi explicitamente documentado sem criar conta extra;
- `Ana Teste — Sprint 2` foi retomada após reload e novo login, sem nova chamada ao modelo;
- histórico, fatos, fontes, tokens, latência e status do job aparecem corretamente ao papel autorizado;
- a interface publicada passou em desktop e mobile;
- a resposta existente recebeu revisão humana e não foi extrapolada para toda a matriz;
- não houve nova chamada paga nem delivery;
- worker, workflow e canais terminaram desativados;
- documentação e evidências sanitizadas foram atualizadas;
- riscos e casos pendentes foram declarados com precisão.

Se algum item depender de uma pessoa, encerre o restante do sprint e apresente um **gate de conclusão** com uma única ação clara para o responsável. Não reduza os critérios para declarar sucesso.

## Formato do relatório final

Entregue ao final:

1. resultado geral: `concluído`, `concluído com ressalvas` ou `bloqueado`;
2. tabela das micro-metas S3.01 a S3.08;
3. matriz de autorização observada;
4. testes e evidências principais;
5. alterações de código e documentação;
6. custo total e número de chamadas/deliveries;
7. estado final de API, worker, n8n, signup e canais;
8. riscos restantes;
9. próximo gate recomendado.

Não exponha segredos no relatório.
