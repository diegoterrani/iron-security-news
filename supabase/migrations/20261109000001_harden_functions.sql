-- Hardening apontado pelos advisors do Supabase (2026-11-09).
-- Compatível com a versão anterior do código: só restringe privilégios e fixa search_path.

-- 1) SECURITY DEFINER expostas via /rest/v1/rpc
-- app_current_role(): continua executável por `authenticated`, porque has_role() (SECURITY INVOKER)
-- a chama dentro das policies de RLS. Só sai do alcance de quem não está logado.
revoke execute on function public.app_current_role() from public, anon;

-- Funções de trigger não precisam de EXECUTE para disparar; ninguém deve chamá-las via RPC.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- rls_auto_enable() é criada pela própria plataforma Supabase (event trigger `ensure_rls`).
-- Pode não existir no Postgres local da CI; por isso o bloco condicional.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- 2) search_path fixo (lint 0011_function_search_path_mutable)
alter function public.set_updated_at()          set search_path = public;
alter function public.story_contents_search()   set search_path = public;
alter function public.has_role(app_role)        set search_path = public;
