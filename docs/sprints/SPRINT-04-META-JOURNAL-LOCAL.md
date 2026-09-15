# Sprint 4 — journal durável local da campanha

13/09/2026. Implementado para permitir retomada auditável do controlador; **nenhuma campanha real foi criada ou executada**. Arquivos: `evaluations/sprint4-journal.spec.ts`, `sprint4-journal.ts` e `tests/sprint4-journal.test.ts`. Não fazem parte da r7 publicada.

O journal usa SQLite nativo, sem nova dependência. Exige diretório local explícito, dedicado, do usuário atual e modo0700; arquivo fixo0600, sem symlink/hardlink. runId é parâmetro SQL, nunca nome de arquivo. A inicialização de armazenamento novo precisa ser explícita e só aceita diretório vazio; reabertura não recria silenciosamente arquivo ausente ou inválido.

Cada CAS usa transação BEGIN IMMEDIATE e acrescenta uma revisão, preservando versões anteriores. Plano e prefixo de intenções/recibos são validados; não há API para reset, apagar recibos, trocar o alvo ou reescrever intenção. Journal em modo DELETE, synchronous=EXTRA e fullfsync habilitados. O commit antecede o ACK. A interface principal retorna Result; a ponte para o controlador rejeita falhas com código sanitizado, em vez de transformá-las em estado vazio ou CAS bem-sucedido.

Sete ciclos RED→GREEN e duas verificações adicionais: **9/9**, mais controlador/planejador **28/28**. Revisão direta do responsável principal e repetição independente28/28,0,820488334s. Dois processos reais disputaram a mesma revisão, exatamente um venceu; ambos foram interrompidos com SIGKILL após ACK e uma nova instância recuperou o estado vencedor. Também verificados rollback de erro SQLite real, formato estrangeiro sem alteração, corrupção, permissões, replay e transições proibidas.

Testado em Node24.13.1/SQLite3.51.2. Compatibilidade de execução com Node22 ainda não testada; interfaces usadas constam nos tipos22 do projeto. O recurso SQLite emite aviso experimental. Não é garantia de durabilidade em NFS, ACLs especiais, falha de energia ou hardware defeituoso. O diretório precisa permanecer íntegro e privado; o journal não substitui a evidência confiável do backend.

Hashes congelados:

- Spec:`5de73eb7fe9ac9e2c5e958fdbdae95423cceb0a0effa036229659d17f401df47`.
- Implementação:`0e5c278bf6a092e16dc269a5de2aa52732f6a8d8514285deac61d335b5a67a56`.
- Testes:`d9cff4cc89d37f1d012ea7ee9b235396e9211ba1f20e0fccb80f8ba9c8d88ffd`.

Faltam integração operacional com o controlador e adaptadores reais de preflight, envio e coleta privada, além de admin, orçamento/capacidade atuais, notas humanas e todos os gates do sprint. Nada neste journal autoriza reenvio de tentativa ambígua ou fabrica avaliação humana.
