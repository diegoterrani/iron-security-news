-- Publicação no blog (§4.10). Aprovar agenda o blog (PT e EN, se houver artigo) para publicação imediata;
-- o executor publica, marca a story como PUBLISHED e pede ao site para se atualizar.
-- As redes sociais ganham channel_posts quando as integrações existirem (até lá: pacote para download).

-- Cria os channel_posts do blog para a versão mais recente de cada artigo (RN-PUB01: idempotency_key).
create or replace function public.schedule_blog_posts(p_story uuid, p_when timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  insert into channel_posts (story_id, channel, lang, status, scheduled_for, content_version, idempotency_key)
  select c.story_id, 'blog', c.lang, 'pending', p_when, c.version,
         encode(sha256(convert_to(c.story_id::text || '|blog|' || c.lang::text || '|' || c.version::text, 'UTF8')), 'hex')
    from latest_contents c
   where c.story_id = p_story and c.channel = 'blog' and c.kind = 'article'
  on conflict (story_id, channel, lang) do nothing;
  get diagnostics n = row_count;
  update stories set status = 'SCHEDULED', scheduled_for = p_when
   where id = p_story and status = 'APPROVED'
     and exists (select 1 from channel_posts where story_id = p_story);
  return n;
end $$;

-- Aprovar agora já agenda o blog (antes, a story parava em APPROVED).
create or replace function public.review_approve(p_story uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
  st story_status;
begin
  update stories set status = 'APPROVED', approved_by = uid, approved_at = now()
   where id = p_story and status = 'AWAITING_REVIEW';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id) values (uid, 'story.approve', 'story', p_story::text);
  perform public.schedule_blog_posts(p_story);
  select status into st from stories where id = p_story;
  return json_build_object('id', p_story, 'status', st);
end $$;

revoke all on function public.schedule_blog_posts(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_blog_posts(uuid, timestamptz) to ironnews_exec;

-- Stories aprovadas antes desta migration entram na agenda.
select public.schedule_blog_posts(id) from stories where status = 'APPROVED';

-- Defesa em profundidade: o padrão do Supabase dá INSERT/UPDATE/DELETE em todas as tabelas a anon e
-- authenticated, e só o RLS (sem políticas de escrita) impedia escritas. Nenhum dos dois escreve direto:
-- o painel usa as RPCs review_* (SECURITY DEFINER) e o executor/workers usam papéis próprios.
-- A leitura continua: o visitante anônimo lê só artigos publicados (RLS pub_stories/pub_contents).
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- Fila de publicação: só o necessário para achar os vencidos rápido.
create index if not exists channel_posts_due on channel_posts (scheduled_for) where status = 'pending';
