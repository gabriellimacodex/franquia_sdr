# Sprint 2 — autorização agrupada para o gate remoto

Estado em 10/09/2026: **gate remoto executado e novamente fechado após uma chamada fictícia dentro do teto**.

## Registro da resposta recebida

- Cadastro público: autorizado, desabilitado e revalidado.
- Contas/memberships: `gabriel.lima@cognitaai.com.br` foi convidado como `tester` e `joao.lucas@cognitaai.com.br` como `reviewer`; ambas as memberships estão ativas em `cognita-homologacao/sapore`.
- API: publicada isoladamente em `https://sdr-api.cognitaai.com.br`; `/health` e `/ready` responderam HTTP 200. O worker processou somente a chamada autorizada e foi parado com código 0.
- n8n: duas credenciais internas exclusivas e a credencial nativa OpenAI foram confirmadas por metadados, sem leitura de seus valores. O workflow novo `SaporeAsyncV1Lab` foi publicado temporariamente, executado uma vez e despublicado; `active=false`, webhook HTTP 404 e os três workflows anteriores preservados.
- Frontend: versão 3 publicada em `https://borelli-expansao.ana-mendes.chatgpt.site`, com ambiente remoto configurado e acesso `custom` somente para os dois e-mails autorizados.
- Modelo: `gpt-5.4-2026-03-05`; teto autorizado de R$ 2,00. Uma chamada concluiu com 1.884 tokens de entrada, 463 de saída e custo estimado de US$ 0,011655 ≈ R$ 0,06.
- WhatsApp e Kapso permanecem desativados. O Caddy recebeu somente um vhost separado para a API; o CRM existente foi verificado antes e depois e continuou respondendo com o mesmo HTTP 307.

Este documento não concede autorização por si só. Ele registra o escopo exato que precisa ser aprovado antes de qualquer mutação remota. Não inserir senhas, tokens, chaves, URLs com credenciais ou dados de candidatos neste arquivo.

## Invariantes que permanecem fechadas

- Somente tenant `cognita-homologacao` e marca `sapore`.
- Somente pessoas e dados fictícios.
- WhatsApp, Kapso, e-mail, CRM e demais canais externos permanecem desativados.
- `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false` e `RETENTION_ENABLED=false`.
- Nenhum workflow existente pode ser modificado.
- O workflow novo do laboratório nasce inativo.
- Nenhum serviço de outro projeto pode ser alterado ou reiniciado.
- Jobs, sessões, histórico e resultados ambíguos não podem ser apagados nem reenviados às cegas.

## Decisões necessárias

Preencher a resposta abaixo fora do repositório. E-mails são dados de acesso; registrar no relatório somente identificadores mínimos e papéis, nunca senhas.

| Gate | Decisão necessária |
| --- | --- |
| Supabase Auth | Autorizar ou negar a desativação do cadastro público. |
| Contas | Informar cada e-mail autorizado e o papel exato: `tester`, `reviewer` ou `admin`. `admin` nunca será inferido. |
| Memberships | Autorizar ou negar a criação das memberships apenas para a lista informada. |
| API na VPS | Autorizar ou negar a publicação isolada da release candidata, primeiro somente API, sem worker. |
| n8n | Autorizar ou negar a criação de um workflow novo, exclusivo e inativo. |
| Modelo | Informar o modelo autorizado para a execução conversacional e o teto monetário total. |
| Chamada paga | Autorizar ou negar uma única chamada inicial com mensagem fictícia. |
| Frontend | Autorizar ou negar a publicação somente depois de login, negação e isolamento reais passarem. |

## Modelo de resposta do responsável

```text
Autorizo o gate remoto do Sprint 2 dentro das invariantes documentadas.

Supabase:
- Desabilitar cadastro público: SIM/NÃO
- Criar contas e memberships: SIM/NÃO

Pessoas autorizadas:
- <e-mail> — tester/reviewer/admin
- <e-mail> — tester/reviewer/admin

Infraestrutura:
- Publicar primeiro somente a API isolada na VPS: SIM/NÃO
- Criar workflow n8n novo e inativo: SIM/NÃO

Modelo:
- Modelo autorizado: <identificador exato>
- Teto total da validação: <valor e moeda>
- Autorizar uma única chamada paga fictícia: SIM/NÃO

Frontend:
- Publicar após os gates técnicos passarem: SIM/NÃO
```

Uma resposta parcial libera somente os itens marcados explicitamente como `SIM`. Ausência de resposta, campo vazio ou formulação ambígua mantém o respectivo gate fechado.

## Ordem de execução após aprovação

1. Confirmar o snapshot remoto e registrar contagens antes da mudança.
2. Desabilitar cadastro público; verificar a configuração por leitura.
3. Criar somente as contas/memberships autorizadas; validar login, logout, negação e isolamento.
4. Reconstruir a release na VPS Linux/amd64 e conferir o hash do pacote.
5. Rodar `npm run preflight:sprint2`; publicar somente a API e validar `/health` e `/ready` pelo proxy HTTPS.
6. Criar o workflow n8n novo, autenticado e inativo; validar o JSON exportado sem credenciais.
7. Ativar o workflow somente para a execução aprovada, iniciar o worker em modo laboratório e realizar uma única chamada fictícia dentro do teto.
8. Verificar resposta estruturada, persistência, tokens, latência, erros, zero `deliveries` e zero chamadas externas.
9. Executar a matriz de 15 cenários e as verificações desktop/mobile com as contas reais de homologação.
10. Publicar o frontend somente após todos os gates anteriores passarem e registrar a aprovação da demonstração.

Qualquer falha interrompe a sequência no gate atual. Não avançar ao próximo item com evidência incompleta.

## Rollback autorizado pelo próprio escopo

- Parar somente a API/worker da nova release.
- Manter todas as flags externas fechadas.
- Desativar somente o workflow novo do laboratório.
- Restaurar o apontamento para a release anterior.
- Preservar banco, jobs e logs para diagnóstico.
- Não excluir dados nem repetir chamadas ambíguas sem nova autorização explícita.
