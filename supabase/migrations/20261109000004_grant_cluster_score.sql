-- Correção: a 20261109000003 revogou o EXECUTE público de cluster_score() sem conceder ao executor.
-- Aplicada à mão em produção em 2026-11-09 (hotfix aprovado); aqui fica versionada. GRANT é idempotente.
grant execute on function public.cluster_score(public.clusters) to ironnews_exec;
