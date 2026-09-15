# Avaliações de homologação

Todos os nomes, cidades associadas a disponibilidade e números das fixtures são dados fictícios de teste. A faixa R$250–280 mil nas fixtures não é uma publicação comercial aprovada de Sapore. Não usar as fixtures como cadastro de produção.

`scenarios.ts` contém 52 cenários executáveis: 14 de qualificação, 12 de controle da conversa, 8 de fontes e 18 de proteção da resposta. `tests/domain.test.ts` também verifica evidência, isolamento, conflitos, substituição humana, separação de origens do capital, contratos e limites da saída.

Execute localmente:

```sh
npm test
```

Esses testes medem regras determinísticas aplicadas a entradas construídas. Eles não chamam GPT, não medem qualidade real da conversa, não são evidência de que o modelo extrai corretamente todos os fatos e não demonstram sucesso ponta a ponta em WhatsApp. Os testes usam assertivas executáveis; não marcam respostas fictícias como saídas medidas do modelo.

O guard numérico aceita a reprodução exata de cláusulas aprovadas e citadas, e rejeita exemplos de números sem fonte, promessas e ações concluídas sem recibo. A parte linguística usa padrões conservadores; não é uma prova de cobertura de todas as paráfrases possíveis. Falsos positivos podem exigir revisão humana. A consulta local de fontes usa relevância lexical, limitada a cinco documentos após filtros de escopo, aprovação, atividade e vigência.

Antes de liberar atendimento real, execute os cenários de comunicação com `gpt-5.4-2026-03-05`, guardando versão do prompt, modelo, configuração, fontes, mensagens recebidas, resposta bruta, resultado do guard, latência e uso de tokens. Não registre segredos de integração. Avalie extração e qualidade da conversa separadamente das ferramentas.

Na revisão humana de cada conversa, verificar: respondeu à intenção atual; fez no máximo uma pergunta útil; preservou faixas, origem e titularidade; aproveitou informações já fornecidas; não inventou números ou execução de ações; respeitou pedidos de humano e interrupção; entregou briefing com lacunas e conflitos explícitos. Não atribuir nota numérica ao candidato.

O briefing usa `gpt-5-mini`. Sua fidelidade precisa ser medida com o histórico correspondente; afirmar fidelidade apenas porque o prompt está presente seria inadequado.

## Recuperação de conhecimento

`tests/knowledge.test.ts` executa SQL e a extensão pgvector em um PostgreSQL local embarcado (PGlite). Verifica filtros de organização, marca e versão; aprovação e vigência canônicas; ranking vetorial e texto completo; cinco fontes distintas; trechos limitados; descarte de texto adulterado; e indexação idempotente. Os vetores são sintéticos para provar o cálculo de ranking, sem afirmar qualidade semântica medida do modelo.

O adaptador `text-embedding-3-small` é testado com resposta HTTP simulada e valida 1536 dimensões. Nenhuma dessas verificações faz chamada real ao provedor. A execução sem vetor válido ou sem vetores indexados identifica o modo como `lexical`; com ambos presentes, o modo é `hybrid`.

O indexador cria trechos de até 2000 caracteres com sobreposição de 200, somente de fontes aprovadas, ativas e vigentes na versão imutável indicada. O contexto recebe até cinco trechos, mantendo as cláusulas comerciais e referências canônicas para validação.

Para indexar uma versão em ambiente configurado:

```sh
node --env-file-if-exists=.env --import tsx scripts/index-knowledge.ts TENANT BRAND VERSION
```

Acrescentar `--embed` usa `OPENAI_API_KEY` no servidor e chama o provedor de embeddings. Sem a chave, permanece no modo lexical. A criação deste script não significa que ele foi executado contra uma base remota.
