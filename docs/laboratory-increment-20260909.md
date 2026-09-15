# Laboratório Sapore — primeiro incremento executado

Atualização posterior: ver [auditoria de acesso de 10/09](lab-access-audit-20260910.md). O cadastro público foi encontrado habilitado nessa nova verificação; a migração remota continua pendente e o runner foi corrigido localmente (83 testes).

## Implementado localmente

- Entrada própria para testadores: conversa livre, investimento, memória/correção e pedido humano. Cenários são orientações para a pessoa, não respostas predefinidas.
- Novo teste cria um candidato fictício independente. Reabrir um teste preserva candidato, mensagens e versão.
- Perfil `tester`, sessões vinculadas ao usuário autenticado e bloqueio das rotas antigas de inspeção para esse perfil. Administradores/revisores mantêm a inspeção da equipe separada da conversa.
- API de criação, listagem, consulta e envio de texto, com contratos validados, idempotência e limite inicial de 100 mensagens por usuário/marca em 24 horas.
- Mensagens entram na fila e no motor existente. Respostas validadas são gravadas atomicamente no laboratório, sem registros de envio ao WhatsApp. Reentrega de callback não duplica respostas.
- Pedidos humanos/stop pausam a conversa e invalidam trabalhos pendentes. Briefings do laboratório nunca geram atribuição à Kapso.
- Filas e briefings separados por canal. Publicar outra versão não invalida a versão fixa de um teste em andamento.
- `EXECUTION_MODE=laboratory` é o padrão: não exige credenciais Kapso; rejeita flags de ativação e bloqueia rotas operacionais WhatsApp. O worker processa somente canais do modo selecionado.

## Verificação

Testes adicionados antes das respectivas implementações, com falha observada e posterior correção. Execução local aprovada: suíte backend com 78 testes (incluindo montagem do certificado de banco no deploy); frontend com 107 testes na verificação anterior.

Revisão visual da entrada feita com o componente e CSS reais, renderizados numa fixture local explicitamente identificada como prévia sem IA. Desktop e 390 px sem overflow horizontal. Essa revisão não equivale a testar chat autenticado no navegador nem a avaliar respostas reais do modelo. A tentativa de verificação de foco pelo navegador foi interrompida por timeout.

O build do frontend passa. `tsc --noEmit` isolado encontra quatro erros de tipos Cloudflare em arquivos não modificados (`cloudflare:workers`, `Fetcher`, `D1Database`); não foram resolvidos neste incremento.

## Migração e liberação ainda pendentes

1. Aplicar `003_lab_sessions.sql` com a conta de migração, registrar no ledger e reaplicar os grants de runtime. **Não foi aplicado ao Supabase neste incremento.** Banco e serviços remotos permaneceram inalterados.
2. Cadastrar contas e memberships da equipe. Uma conta `tester` não pode ler dados de outros testadores pelas APIs. Não existe autocadastro.
3. Configurar URLs HTTPS, segredos internos rotacionados e endpoint n8n com credenciais válidas de modelo. Atualizar o worker para a mesma release e definir `EXECUTION_MODE=laboratory`.
4. Executar chat ponta a ponta em homologação com login real, verificar recuperação após reinício, teclado e mobile na conversa, medir custos/latência e definir teto de gasto. O limite de mensagens não é um teto monetário.
5. Próximo incremento de produto: feedback por resposta, encerramento/avaliação final pelo testador, visualização do briefing e comparação de resultados no laboratório. A inspeção técnica e avaliação preexistentes continuam disponíveis à equipe.
6. Rodar a suíte conversacional com modelo real e revisão humana antes de compartilhar amplamente. Nenhum resultado de testes mockados deve ser registrado como qualidade medida de IA.

## Endpoints

- `GET /v1/me`: identidade e perfil derivados do token e membership.
- `GET/POST /v1/lab/sessions`: sessões próprias / novo candidato fictício com versão fixa.
- `GET /v1/lab/sessions/:id`: sessão própria, histórico e estado do último trabalho.
- `POST /v1/lab/sessions/:id/messages`: `{requestId: UUID, text: string}`. Repetir o mesmo identificador e conteúdo é seguro; alterar o conteúdo com o mesmo identificador resulta em conflito.

A página do produto permanece `/laboratorio-sdr`. Sem configuração e acesso autorizados, mostra indisponibilidade; não substitui o agente por simulação.

## Preparação remota — 09/09/2026

- Verificação somente leitura do Supabase aprovada: 21 tabelas, 17 com RLS forçada, isolamento de marca/tenant e privilégios restritos. Canal segue desativado; migração 003 ainda pendente.
- Corrigido o Compose para montar a CA confiável do Supabase em API e worker, com caminhos de ambiente/certificado configuráveis. API permanece vinculada ao loopback.
- Release preparada em `/opt/sapore-sdr/releases/20260909T182937Z`; arquivo de origem verificado por SHA-256 `740d5b61f2005d249ac9a4cd2adecbbb5727cad00412df7d067bde311dab04c3`.
- Imagem `sapore-sdr:homologacao-20260909t182937z` construída na VPS, incluindo verificação TypeScript. Nenhum serviço do laboratório iniciado e nenhuma configuração das aplicações existentes alterada.
- Compose validado; 78/78 testes aprovados na imagem da VPS em contêiner temporário sem rede, limitado a 1 CPU e 1 GiB. Essa suíte usa dependências simuladas/banco de teste, não mede qualidade ou latência de IA real.
- Confirmada a existência de um workflow anterior de chat Sapore ativo no n8n, com referência a uma credencial OpenAI. Isso não valida a credencial nem equivale ao novo workflow assíncrono. O workflow anterior não foi modificado.
- Publicação existente do frontend confirmada como privada, restrita ao proprietário. Não foi publicada nova versão nem concedido acesso adicional.
- Pendências de liberação: acesso administrativo para migração (controle de navegador indisponível), confirmação dos e-mails da equipe, endereços HTTPS e orçamento dos testes pagos. Nenhuma chamada de modelo realizada nesta preparação.
