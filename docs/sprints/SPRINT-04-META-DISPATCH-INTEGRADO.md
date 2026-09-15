# Sprint 4 — preparo unificado, integração local

13/09/2026. **Não publicado; M3 e o sprint continuam abertos.** R7 é a última versão publicada. Esta etapa não altera modelo, snapshot ativo, frontend, n8n, permissões, schema ou cota.

## Mudança e controles

`LaboratoryDispatch` agrupa preflight, preparo e reserva numa transação: 18 → 9 viagens incluindo BEGIN/COMMIT. Claim continua separado, preservando tentativas/lease/expiração. O HTTP só recebe o corpo após commit; o ACK mantém sua própria transação e UPDATE condicionado ao estado/tentativa. Dispatch completo passa de 22 viagens/4 transações para 13/2. A conclusão agrupada elimina outras quatro viagens.

O corpo enviado é a mesma string usada no cálculo de bytes UTF-8 e reserva. Não há embedding, transcrição ou chamada extra no laboratório. Áudio sem texto e trigger não suportado mantêm a resposta gratuita. Janela de áudio da conversa e histórico da candidata são distintos; v1/v2, hash, modelo, escopo e propriedade das evidências permanecem verificados. Fonte usa o mesmo instante normalizado em milissegundos nos filtros JS/SQL. O caminho omitido de `retrieveKnowledge` preserva os comandos/parâmetros antigos.

Saldo e duplicação são conferidos sob o lock da marca, adquirido em instrução anterior ao snapshot de leitura. Contexto e reserva fazem commit juntos; expiração antes/durante a reserva ou falha SQL provoca rollback. A reserva também exige `deadline > clock_timestamp()` no banco. Não foi removido lock nem enfraquecida a liquidação conservadora de tentativas ambíguas.

Tempos privados agora descrevem uma fase única: `dispatchPreparationUntilContextWriteMs` termina antes de UPDATE/reserva/commit; `dispatchPreparationMs` inclui o retorno do preparo commitado. ACK tardio não reabre job e não inventa métricas de etapas que não mediu. Metadados não entram no body do modelo nem no detalhe público.

## Evidência local

- Consolidação final: `npm run build && node --import tsx --test --test-concurrency=4 tests/*.test.ts`, **319/319 + TypeScript**, zero falhas/skips/cancelamentos, 48,943954167 s. PostgreSQL real separado final **4/4**, 1,055028292 s; fixture sintética encerrada após a prova. Esses resultados não alteram o pacote remoto r7.
- Coordenador: 18 testes, 12 RED→GREEN funcionais. Batch original 39/39 com conhecimento/orçamento. Correção adicional do instante normalizado: mais um RED→GREEN; conjunto conhecimento 11/11.
- Integração Engine: três RED→GREEN — quatro versus duas transações, tempo parcial no callback antes do ACK e fase completa após ACK. Testes exigem corpo exato, reserva commitada antes do transporte, uma resposta e liquidação única.
- Subset integrado 35/35, 11,896548708 s, e TypeScript aprovados. Somente expectativas de contagens/rótulos dos testes antigos foram atualizadas para a nova organização; asserts funcionais, guard, privacidade, controles e ledger preservados.
- Revisão independente de código sem bloqueadores materiais. O batch completo adicional do revisor foi interrompido para evitar interferência na medição; cancelamentos não são uma aprovação. A consolidação única da árvore será registrada no progresso.
- PostgreSQL real: 4/4, 1,312323459 s. Três provas anteriores de bloqueios/rollback e uma disputa de saldo entre conexões separadas. A segunda operação esperou no advisory lock observado em `pg_locks` e, após commit da primeira, recusou outra reserva que excederia 60.000 microUSD sintéticos. Apenas o ranking pgvector foi substituído por resultado lexical vazio porque a imagem local não contém a extensão; SQL de header/contexto/ledger e transações são reais. O primeiro erro desse teste foi falta da coluna `kind` na fixture, corrigida com a instrução literal da migration 003; não foi defeito do produto nem ciclo RED→GREEN funcional.

As contagens de subconjuntos se sobrepõem. Nenhum desses testes é homologação do modelo ou prova de UI publicada.

## Comparação e decisão

[Artefato da medição](SPRINT-04-META-LATENCIA-FUSED-20260913.json), com todas as quatro amostras:

| RTT artificial | Provedor artificial | Detalhe autorizado | Commit do callback |
| ---: | ---: | ---: | ---: |
| 136,984 ms | 3 s | 9,682 s | 9,257 s |
| 136,984 ms | 5,5 s | 12,605 s | 12,184 s |
| 10 ms | 3 s | 5,278 s | 4,433 s |
| 10 ms | 5,5 s | 7,833 s | 6,947 s |

A [baseline r7](SPRINT-04-META-LATENCIA-COMPLETION-20260913.json) registrou 12,094/14,451 s com RTT de 136,984 ms. Existe redução estrutural demonstrada, porém **não há evidência para atender 5/8 s**. Uma amostra por caso, CPU não totalmente isolada, Auth/ACK simulados zero e ausência de navegador impedem promessa de ganho remoto ou inferência de percentis. Mesmo o contrafactual de rede mais rápida deixa espera de descoberta/polling e lacunas importantes.

**Decisão: não publicar este conjunto como solução da fluidez nem gastar em nova bateria paga baseada nessa hipótese insuficiente.** Próxima decisão deve considerar menor latência efetiva API–banco e descoberta pós-commit; contratação, infraestrutura ou migração exigem autorização própria. A implementação permanece local, testada e disponível para compor essa solução. Não relaxar os critérios nem transferir M3 para outro sprint.

## Diagnóstico remoto somente leitura

13/09, 23:03:59.389 UTC, API r7 saudável: endpoint atual `aws-0-us-east-2.pooler.supabase.com:5432`, TLS habilitado. Cinco `SELECT 1`, após aquecer o pool: 139,702 / 145,218 / 140,287 / 138,109 / 139,906 ms; mediana **139,906 ms**. Região do projeto confirmada novamente `us-east-2`, estado `ACTIVE_HEALTHY`. O endpoint não aponta para uma região diferente da registrada no projeto.

Às 23:04:30.432 UTC, probe exclusivamente DNS/TCP do endpoint direto `db.xxvfuyydhfijhudtytsk.supabase.co:5432` resolveu IPv6, mas o contêiner retornou `ENETUNREACH`. Nenhuma autenticação direta foi tentada, chave impressa, conexão de produção trocada ou configuração de rede alterada. Isso não prova que outro host/IPv6 corrigido atingiria um RTT específico.

A documentação oficial indica conexão direta para servidores persistentes e pooler em modo sessão para redes apenas IPv4; o modo sessão atual é coerente com a conectividade observada. Isso não elimina a necessidade de medir desempenho real nem autoriza contratar um add-on. [Conexões PostgreSQL do Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).
