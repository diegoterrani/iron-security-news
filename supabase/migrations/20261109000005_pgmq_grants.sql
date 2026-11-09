-- Correção: o executor tinha EXECUTE nas funções do pgmq, mas não acesso às tabelas das filas
-- (pgmq.q_*, pgmq.a_*, meta e sequências). As funções do pgmq rodam com os privilégios de quem chama,
-- então send/read/archive falhavam com "permission denied for table q_story_build".
-- Aplicada à mão em produção em 2026-11-09 (hotfix aprovado); aqui fica versionada. GRANT é idempotente.
grant select, insert, update, delete on all tables in schema pgmq to ironnews_exec;
grant usage, select on all sequences in schema pgmq to ironnews_exec;

-- Filas criadas no futuro (pgmq.create roda como o dono das migrations) já nascem acessíveis.
alter default privileges in schema pgmq grant select, insert, update, delete on tables to ironnews_exec;
alter default privileges in schema pgmq grant usage, select on sequences to ironnews_exec;
