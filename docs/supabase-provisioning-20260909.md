# Supabase configurado — 09/09/2026

Projeto: `xxvfuyydhfijhudtytsk`, organização Sapore, região `us-east-2`. Preparação para homologação, sem ativação do canal.

## Aplicado e verificado

- API de Auth e Data API acessíveis com as credenciais fornecidas. DDL executado pela sessão administrativa já autenticada no SQL Editor, sem resetar a senha de `postgres`.
- Preflight: schema `sdr`, papel `sdr_runtime` e ledger inexistentes; nenhuma tabela de aplicação em `public`. Não foi reutilizada estrutura de outro produto.
- Migrações `001_sdr` e `002_versions` aplicadas em uma transação e registradas em `public.sapore_sdr_migrations`: 21 tabelas no schema privado, 17 com RLS habilitada e forçada. As quatro tabelas operacionais globais são acessíveis somente ao backend/admin pelos grants.
- Ledger com RLS e privilégios HTTP revogados; hardening de schema, tabelas, sequências, funções e defaults locais aplicado. `anon`, `authenticated` e `service_role` sem USAGE em `sdr` e sem leitura do ledger.
- Extensão `vector` instalada em `public`; tipo e operador de distância resolvidos pelo runtime. Nenhum embedding gerado e nenhuma chamada a modelo nesta etapa.
- Papel exclusivo `sdr_runtime`, sem SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION ou herança. Grants operacionais e de publicação aplicados; sem permissão para habilitar canal, apagar versões, alterar schema ou ler o ledger.
- Marca `cognita-homologacao/sapore`, três testadores autorizados, um canal **desabilitado**, uma versão **não avaliada** e uma fonte comercial autorizada para homologação. Nenhum candidato ou mensagem real criado.
- Versão `sapore-v1-a1a330f07cd0`, SHA-256 `a1a330f07cd0efc5bf2193c57e7a7c12c09b4c8518c524d0b36d4c6e026c1325`. O hash armazenado foi recalculado e conferido. Investimento R$ 250–280 mil; composição, royalties, retorno e território continuam desconhecidos.
- Login por e-mail habilitado; cadastro público desabilitado; login anônimo desabilitado; confirmação de e-mail preservada.
- TLS obrigatório habilitado no banco. Certificado oficial Supabase Root 2021 CA obtido pelo link do Dashboard; fingerprint SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

## Verificações reais

Conexão pelo session pooler `aws-0-us-east-2.pooler.supabase.com:5432`, com verificação de CA e hostname ativa. A confiança usa `NODE_EXTRA_CA_CERTS`; não foi usado `rejectUnauthorized:false`.

- Teste local com o driver da aplicação: 21 tabelas, 17 RLS forçadas, três testadores visíveis apenas no escopo correto, outras marcas/organizações invisíveis, versão íntegra e canal desligado.
- API pública: Auth retornou `disable_signup=true`; consulta ao ledger retornou HTTP 401 / SQLSTATE 42501; tentativa de selecionar o schema `sdr` retornou HTTP 406 / PGRST106. A Data API não expõe `sdr`.
- VPS: container temporário da imagem Sapore conectou como `sdr_runtime`, consultou a marca e encerrou/removido. Nenhuma API ou worker persistente iniciado. Os 11 containers anteriores continuaram em execução.
- Código: TypeScript e 71 testes locais aprovados após corrigir provisionamento para administrador gerenciado não-superuser e testar o hardening. Esses testes usam PGlite/transportes simulados; as verificações acima usam o projeto remoto real.

## Credenciais e próxima implantação

Uma senha aleatória exclusiva foi gerada para `sdr_runtime`. O SQL não contém sua senha literal. Arquivos locais em `.local/` (diretório 0700, envs 0600), ignorados pelo Git. Não há chave secreta Supabase no frontend nem no código versionado.

Na VPS:

- `/opt/sapore-sdr/shared` — diretório 0700.
- `/opt/sapore-sdr/shared/database.env` — configuração parcial do banco e chave pública Auth, 0600.
- `/opt/sapore-sdr/shared/supabase-ca.crt` — certificado público, 0644.

Ao implantar API e worker, montar o certificado como `/run/secrets/supabase-ca.crt` somente leitura e manter `NODE_EXTRA_CA_CERTS=/run/secrets/supabase-ca.crt`. Mesclar a configuração parcial com os demais segredos, sem imprimir os valores. A imagem preparada em 08/09 não contém as correções de provisionamento feitas em 09/09; usar novo release no próximo deploy. Não iniciar o worker apenas para testar a conexão.

## Ainda pendente

- Confirmar e-mail do administrador do laboratório, criar usuário Supabase Auth e associar seu UUID em `sdr.memberships`. Nenhuma conta de usuário ou convite foi criado nesta etapa.
- Resolver ID Kapso de Gábriel Limá. `responsible_user_id` permanece NULL; não inventar um identificador.
- Origem HTTPS do backend/laboratório, configurações completas n8n/Kapso, prova de handoff/retomada e recibo nativo de envio.
- Avaliações conversacionais, backup/restauração e revisão das restrições de rede antes de produção. O projeto usa plano Free; não foi contratado serviço pago ou habilitado backup presumido.
- Rotacionar as credenciais compartilhadas em chat antes de ativar o piloto. A retenção do worker continua desligada; não houve exclusão de dados.

Esta configuração não equivale a liberação para produção nem a aprovação da qualidade do agente.
