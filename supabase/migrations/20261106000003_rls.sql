-- Papel do usuário atual
create or replace function public.app_current_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;
create or replace function public.has_role(min app_role) returns boolean
language sql stable as $$
  select coalesce(
    array_position(array['viewer','editor','admin']::app_role[], public.app_current_role())
    >= array_position(array['viewer','editor','admin']::app_role[], min), false)
$$;

-- Versão mais recente de cada conteúdo
create view latest_contents with (security_invoker = true) as
select distinct on (story_id, channel, lang, kind) *
from story_contents order by story_id, channel, lang, kind, version desc;

-- Artigos públicos (blog)
create view public_articles with (security_invoker = true) as
select s.id, s.category, s.severity, s.cve_ids, s.tags, s.published_at, s.facts,
       c.lang, c.title, c.body,
       case c.lang when 'pt' then s.slug_pt else s.slug_en end as slug
from stories s join latest_contents c
  on c.story_id = s.id and c.channel = 'blog' and c.kind = 'article'
where s.status in ('PUBLISHED','PARTIAL') and s.published_at is not null;

alter table brands         enable row level security;
alter table profiles       enable row level security;
alter table settings       enable row level security;
alter table sources        enable row level security;
alter table clusters       enable row level security;
alter table raw_items      enable row level security;
alter table stories        enable row level security;
alter table story_sources  enable row level security;
alter table story_contents enable row level security;
alter table assets         enable row level security;
alter table integrations   enable row level security;
alter table channel_posts  enable row level security;
alter table heygen_pool    enable row level security;
alter table cve_cache      enable row level security;
alter table llm_usage      enable row level security;
alter table audit_log      enable row level security;
alter table rate_limits    enable row level security;

-- Público (anon): só artigos/ativos publicados
create policy pub_stories on stories for select to anon
  using (status in ('PUBLISHED','PARTIAL'));
create policy pub_contents on story_contents for select to anon
  using (channel = 'blog' and kind = 'article'
         and exists (select 1 from stories s where s.id = story_id and s.status in ('PUBLISHED','PARTIAL')));
create policy pub_assets on assets for select to anon
  using (kind = 'cover' and exists (select 1 from stories s where s.id = story_id and s.status in ('PUBLISHED','PARTIAL')));

-- Painel: leitura viewer+, escrita conforme papel
create policy read_all_stories   on stories        for select to authenticated using (has_role('viewer'));
create policy read_all_contents  on story_contents for select to authenticated using (has_role('viewer'));
create policy read_all_assets    on assets         for select to authenticated using (has_role('viewer'));
create policy read_all_posts     on channel_posts  for select to authenticated using (has_role('viewer'));
create policy read_clusters      on clusters       for select to authenticated using (has_role('viewer'));
create policy read_items         on raw_items      for select to authenticated using (has_role('viewer'));
create policy read_story_sources on story_sources  for select to authenticated using (has_role('viewer'));
create policy read_sources       on sources        for select to authenticated using (has_role('viewer'));
create policy read_settings      on settings       for select to authenticated using (has_role('viewer'));
create policy read_usage         on llm_usage      for select to authenticated using (has_role('viewer'));
create policy read_pool          on heygen_pool    for select to authenticated using (has_role('admin'));
create policy read_audit         on audit_log      for select to authenticated using (has_role('admin'));
create policy self_profile       on profiles       for select to authenticated using (id = auth.uid() or has_role('admin'));
-- integrations: SEM policy para authenticated (tokens nunca saem pelo supabase-js).
-- Mutações do painel passam pelos Route Handlers, que usam o pool Postgres com role
-- `ironnews_web` (abaixo) após checar o papel na sessão.

-- Roles de serviço (login via pooler; senhas em secrets)
create role ironnews_exec login bypassrls;   -- VPS executor  (senha definida fora da migration)
create role ironnews_web  login bypassrls;   -- Route Handlers (Vercel)
grant usage on schema public, pgmq to ironnews_exec, ironnews_web;
grant select, insert, update, delete on all tables in schema public to ironnews_exec;
grant select, insert, update on stories, story_contents, channel_posts, sources, settings,
      heygen_pool, audit_log, rate_limits, integrations, clusters to ironnews_web;
grant select on all tables in schema public to ironnews_web;
grant usage, select on all sequences in schema public to ironnews_exec, ironnews_web;
grant execute on all functions in schema pgmq to ironnews_exec, ironnews_web;

-- Storage: bucket público só leitura; escrita só pelo executor (service key)
insert into storage.buckets (id, name, public) values ('media','media', true)
  on conflict (id) do nothing;

-- RPC para o Worker edge-hooks enfileirar sem acesso amplo
create or replace function public.enqueue_video_event(payload jsonb) returns bigint
language sql security definer set search_path = public, pgmq as $$
  select pgmq.send('video_events', payload)
$$;
revoke all on function public.enqueue_video_event(jsonb) from public, anon, authenticated;
-- Chamado pelo Worker com a service_role key (fica só no secret do Worker).

-- Novo usuário → profile (viewer); promoção para editor/admin é manual por admin
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
