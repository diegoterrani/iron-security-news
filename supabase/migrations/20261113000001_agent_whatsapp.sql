-- Agente do WhatsApp (OpenClaw) operando a revisão e a publicação em nome de um admin.
--
-- As RPCs review_* exigem sessão com MFA (review_guard) e continuam assim para o painel. O agente chama a
-- API /api/agent/v1/* do app web, que usa a service_role e estas funções agent_*:
--   * cada review_* foi separada em  guard (painel)  +  *_core(regra de negócio, ator explícito);
--   * agent_* (só service_role) confere que p_actor é admin em profiles e chama o mesmo *_core,
--     registrando diff.via = 'whatsapp' no audit_log.
-- Assim a regra de negócio fica num lugar só e o painel não muda de comportamento.

-- ─── Núcleo (sem guard). Ninguém executa direto: só as funções abaixo, que são SECURITY DEFINER. ───

create or replace function public.review_approve_core(p_story uuid, p_actor uuid, p_when timestamptz, p_via text)
returns json language plpgsql security definer set search_path = public as $$
declare
  st story_status;
begin
  update stories set status = 'APPROVED', approved_by = p_actor, approved_at = now()
   where id = p_story and status = 'AWAITING_REVIEW';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (p_actor, 'story.approve', 'story', p_story::text,
          case when p_via is null and p_when is null then null
               else jsonb_strip_nulls(jsonb_build_object('via', p_via, 'scheduled_for', p_when)) end);
  perform public.schedule_blog_posts(p_story, coalesce(p_when, now()));
  select status into st from stories where id = p_story;
  return json_build_object('id', p_story, 'status', st);
end $$;

create or replace function public.review_reject_core(p_story uuid, p_actor uuid, p_reason text, p_via text)
returns json language plpgsql security definer set search_path = public as $$
declare
  reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(reason) < 3 or char_length(reason) > 500 then
    raise exception 'VALIDATION_ERROR: motivo entre 3 e 500 caracteres' using errcode = '22023';
  end if;
  update stories set status = 'REJECTED', rejected_by = p_actor, rejected_reason = reason
   where id = p_story and status = 'AWAITING_REVIEW';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (p_actor, 'story.reject', 'story', p_story::text, jsonb_strip_nulls(jsonb_build_object('reason', reason, 'via', p_via)));
  return json_build_object('id', p_story, 'status', 'REJECTED');
end $$;

create or replace function public.review_edit_core(
  p_story uuid, p_actor uuid, p_channel channel, p_lang lang, p_kind text, p_title text, p_patch jsonb, p_via text
) returns json language plpgsql security definer set search_path = public as $$
declare
  cur story_contents;
  next_version int;
begin
  if jsonb_typeof(p_patch) <> 'object' or octet_length(p_patch::text) > 60000 then
    raise exception 'VALIDATION_ERROR: alteração inválida' using errcode = '22023';
  end if;
  perform 1 from stories where id = p_story and status = 'AWAITING_REVIEW';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  select * into cur from story_contents
   where story_id = p_story and channel = p_channel and lang = p_lang and kind = p_kind
   order by version desc limit 1;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  next_version := cur.version + 1;
  insert into story_contents (story_id, channel, lang, kind, version, title, body, edited_by, model, prompt_version)
  values (p_story, p_channel, p_lang, p_kind, next_version, coalesce(nullif(btrim(p_title), ''), cur.title),
          cur.body || p_patch, p_actor, null, null);
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (p_actor, 'content.edit', 'story_content', p_story::text,
          jsonb_strip_nulls(jsonb_build_object('channel', p_channel, 'lang', p_lang, 'kind', p_kind, 'version', next_version,
                             'fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k), 'via', p_via)));
  -- Título do artigo, slides, cartão e gancho do Short aparecem nas imagens: renderiza de novo.
  if p_channel in ('blog', 'instagram', 'linkedin', 'youtube') then
    perform pgmq.send('render'::text,
      jsonb_build_object('v', 1, 'traceId', gen_random_uuid()::text, 'attempt', 1, 'payload', jsonb_build_object('story_id', p_story)),
      0::integer);
  end if;
  return json_build_object('id', p_story, 'version', next_version);
end $$;

create or replace function public.review_publish_instagram_core(p_story uuid, p_actor uuid, p_lang lang, p_via text)
returns json language plpgsql security definer set search_path = public as $$
declare
  st story_status;
  integ uuid;
  ver int;
  slides int;
  post channel_posts;
begin
  select status into st from stories where id = p_story;
  if st is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Só conteúdo revisado vai para a rede: aprovar primeiro (o blog sai junto na aprovação).
  if st not in ('APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL') then
    raise exception 'VALIDATION_ERROR: aprove a story antes de publicar no Instagram' using errcode = '22023';
  end if;

  select i.id into integ
    from integrations i join stories s on s.brand_id = i.brand_id
   where s.id = p_story and i.channel = 'instagram' and i.lang = p_lang
     and i.status = 'active' and (i.expires_at is null or i.expires_at > now());
  if integ is null then
    raise exception 'VALIDATION_ERROR: nenhuma conta do Instagram conectada (Integrações)' using errcode = '22023';
  end if;

  select c.version into ver from latest_contents c
   where c.story_id = p_story and c.channel = 'instagram' and c.lang = p_lang and c.kind = 'carousel';
  select count(distinct position) into slides from assets
   where story_id = p_story and channel = 'instagram' and lang = p_lang and kind = 'carousel_slide' and status = 'ready';
  if ver is null or slides < 2 then
    raise exception 'VALIDATION_ERROR: o carrossel ainda não está pronto' using errcode = '22023';
  end if;

  select * into post from channel_posts where story_id = p_story and channel = 'instagram' and lang = p_lang for update;
  if found then
    if post.status = 'published' then
      raise exception 'VALIDATION_ERROR: já publicado no Instagram' using errcode = '22023';
    elsif post.status in ('pending', 'publishing') then
      return json_build_object('id', post.id, 'status', post.status);
    end if;
    -- failed / skipped (modo de teste): reabre para nova tentativa, com a versão atual do conteúdo.
    update channel_posts set status = 'pending', scheduled_for = now(), content_version = ver, integration_id = integ,
                             last_error = null,
                             idempotency_key = encode(sha256(convert_to(p_story::text || '|instagram|' || p_lang::text || '|' || ver::text || '|' || now()::text, 'UTF8')), 'hex')
     where id = post.id;
  else
    insert into channel_posts (story_id, channel, lang, integration_id, status, scheduled_for, content_version, idempotency_key)
    values (p_story, 'instagram', p_lang, integ, 'pending', now(), ver,
            encode(sha256(convert_to(p_story::text || '|instagram|' || p_lang::text || '|' || ver::text, 'UTF8')), 'hex'))
    returning * into post;
  end if;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (p_actor, 'post.publish_request', 'story', p_story::text,
          jsonb_strip_nulls(jsonb_build_object('channel', 'instagram', 'lang', p_lang, 'version', ver, 'via', p_via)));
  return json_build_object('id', post.id, 'status', 'pending');
end $$;

create or replace function public.review_publish_linkedin_core(p_story uuid, p_actor uuid, p_target text, p_lang lang, p_via text)
returns json language plpgsql security definer set search_path = public as $$
declare
  st story_status;
  integ uuid;
  ver int;
  card int;
  post channel_posts;
  where_label text := case p_target when 'member' then 'no perfil' else 'na página' end;
begin
  if coalesce(p_target, '') not in ('member', 'organization') then
    raise exception 'VALIDATION_ERROR: alvo inválido' using errcode = '22023';
  end if;
  select status into st from stories where id = p_story;
  if st is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if st not in ('APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL') then
    raise exception 'VALIDATION_ERROR: aprove a story antes de publicar no LinkedIn' using errcode = '22023';
  end if;

  select i.id into integ
    from integrations i join stories s on s.brand_id = i.brand_id
   where s.id = p_story and i.channel = 'linkedin' and i.lang = p_lang and i.target = p_target
     and i.status = 'active' and (i.expires_at is null or i.expires_at > now());
  if integ is null then
    raise exception 'VALIDATION_ERROR: nenhuma conta do LinkedIn conectada % (Integrações)', where_label using errcode = '22023';
  end if;

  select c.version into ver from latest_contents c
   where c.story_id = p_story and c.channel = 'linkedin' and c.lang = p_lang and c.kind = 'post';
  select count(*) into card from assets
   where story_id = p_story and channel = 'linkedin' and lang = p_lang and kind = 'card' and status = 'ready';
  if ver is null or card = 0 then
    raise exception 'VALIDATION_ERROR: o post do LinkedIn ainda não está pronto' using errcode = '22023';
  end if;

  select * into post from channel_posts
   where story_id = p_story and channel = 'linkedin' and lang = p_lang and target = p_target for update;
  if found then
    if post.status = 'published' then
      raise exception 'VALIDATION_ERROR: já publicado no LinkedIn %', where_label using errcode = '22023';
    elsif post.status in ('pending', 'publishing') then
      return json_build_object('id', post.id, 'status', post.status);
    end if;
    -- failed / skipped (modo de teste): reabre com a versão atual do conteúdo.
    update channel_posts set status = 'pending', scheduled_for = now(), content_version = ver, integration_id = integ,
                             last_error = null,
                             idempotency_key = encode(sha256(convert_to(p_story::text || '|linkedin|' || p_target || '|' || p_lang::text || '|' || ver::text || '|' || now()::text, 'UTF8')), 'hex')
     where id = post.id;
  else
    insert into channel_posts (story_id, channel, lang, target, integration_id, status, scheduled_for, content_version, idempotency_key)
    values (p_story, 'linkedin', p_lang, p_target, integ, 'pending', now(), ver,
            encode(sha256(convert_to(p_story::text || '|linkedin|' || p_target || '|' || p_lang::text || '|' || ver::text, 'UTF8')), 'hex'))
    returning * into post;
  end if;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (p_actor, 'post.publish_request', 'story', p_story::text,
          jsonb_strip_nulls(jsonb_build_object('channel', 'linkedin', 'target', p_target, 'lang', p_lang, 'version', ver, 'via', p_via)));
  return json_build_object('id', post.id, 'status', 'pending');
end $$;

revoke all on function public.review_approve_core(uuid, uuid, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.review_reject_core(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.review_edit_core(uuid, uuid, channel, lang, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.review_publish_instagram_core(uuid, uuid, lang, text) from public, anon, authenticated, service_role;
revoke all on function public.review_publish_linkedin_core(uuid, uuid, text, lang, text) from public, anon, authenticated, service_role;

-- ─── Painel: mesmas assinaturas e regras de antes (guard com MFA), agora delegando ao núcleo. ───

create or replace function public.review_approve(p_story uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_approve_core(p_story, public.review_guard('editor'), null, null);
end $$;

create or replace function public.review_reject(p_story uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_reject_core(p_story, public.review_guard('editor'), p_reason, null);
end $$;

create or replace function public.review_edit(
  p_story uuid, p_channel channel, p_lang lang, p_kind text, p_title text, p_patch jsonb
) returns json language plpgsql security definer set search_path = public as $$
begin
  return public.review_edit_core(p_story, public.review_guard('editor'), p_channel, p_lang, p_kind, p_title, p_patch, null);
end $$;

create or replace function public.review_publish_instagram(p_story uuid, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_publish_instagram_core(p_story, public.review_guard('admin'), p_lang, null);
end $$;

create or replace function public.review_publish_linkedin(p_story uuid, p_target text, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_publish_linkedin_core(p_story, public.review_guard('admin'), p_target, p_lang, null);
end $$;

-- ─── Agente (só service_role). p_actor precisa ser admin em profiles. ───

create or replace function public.agent_actor(p_actor uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if p_actor is null or not exists (select 1 from profiles where id = p_actor and role = 'admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return p_actor;
end $$;

create or replace function public.agent_approve(p_actor uuid, p_story uuid, p_when timestamptz default null) returns json
language plpgsql security definer set search_path = public as $$
begin
  if p_when is not null and (p_when < now() - interval '5 minutes' or p_when > now() + interval '30 days') then
    raise exception 'VALIDATION_ERROR: horário de publicação deve ser entre agora e 30 dias' using errcode = '22023';
  end if;
  return public.review_approve_core(p_story, public.agent_actor(p_actor), p_when, 'whatsapp');
end $$;

create or replace function public.agent_reject(p_actor uuid, p_story uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_reject_core(p_story, public.agent_actor(p_actor), p_reason, 'whatsapp');
end $$;

create or replace function public.agent_edit(
  p_actor uuid, p_story uuid, p_channel channel, p_lang lang, p_kind text, p_title text, p_patch jsonb
) returns json language plpgsql security definer set search_path = public as $$
begin
  return public.review_edit_core(p_story, public.agent_actor(p_actor), p_channel, p_lang, p_kind, p_title, p_patch, 'whatsapp');
end $$;

create or replace function public.agent_publish_instagram(p_actor uuid, p_story uuid, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_publish_instagram_core(p_story, public.agent_actor(p_actor), p_lang, 'whatsapp');
end $$;

create or replace function public.agent_publish_linkedin(p_actor uuid, p_story uuid, p_target text, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
begin
  return public.review_publish_linkedin_core(p_story, public.agent_actor(p_actor), p_target, p_lang, 'whatsapp');
end $$;

-- Pausar/retomar uma fonte de notícias (não existia RPC). Retomar zera o contador de falhas.
create or replace function public.agent_set_source_enabled(p_actor uuid, p_source uuid, p_enabled boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.agent_actor(p_actor);
  src sources;
begin
  update sources set enabled = p_enabled,
                     consecutive_failures = case when p_enabled then 0 else consecutive_failures end
   where id = p_source
  returning * into src;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, case when p_enabled then 'source.resume' else 'source.pause' end, 'source', p_source::text,
          jsonb_build_object('name', src.name, 'via', 'whatsapp'));
  return json_build_object('id', src.id, 'name', src.name, 'enabled', src.enabled);
end $$;

revoke all on function public.agent_actor(uuid) from public, anon, authenticated, service_role;
revoke all on function public.agent_approve(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.agent_reject(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.agent_edit(uuid, uuid, channel, lang, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.agent_publish_instagram(uuid, uuid, lang) from public, anon, authenticated;
revoke all on function public.agent_publish_linkedin(uuid, uuid, text, lang) from public, anon, authenticated;
revoke all on function public.agent_set_source_enabled(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.agent_approve(uuid, uuid, timestamptz) to service_role;
grant execute on function public.agent_reject(uuid, uuid, text) to service_role;
grant execute on function public.agent_edit(uuid, uuid, channel, lang, text, text, jsonb) to service_role;
grant execute on function public.agent_publish_instagram(uuid, uuid, lang) to service_role;
grant execute on function public.agent_publish_linkedin(uuid, uuid, text, lang) to service_role;
grant execute on function public.agent_set_source_enabled(uuid, uuid, boolean) to service_role;

-- ─── Confirmação por código (entregue ao admin fora do LLM) e auditoria das chamadas do agente. ───

create table if not exists public.agent_confirmations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  attempts smallint not null default 0,
  tool text not null,
  args_hash text not null,
  actor uuid references profiles(id) on delete cascade,
  preview text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_confirmations_expires on public.agent_confirmations (expires_at);

create table if not exists public.agent_audit_log (
  id bigint generated always as identity primary key,
  tool text not null,
  wa_sender text,
  actor uuid references profiles(id) on delete set null,
  args jsonb,
  outcome text not null check (outcome in ('ok', 'confirmation_required', 'denied', 'invalid', 'error')),
  error text,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index if not exists agent_audit_log_created on public.agent_audit_log (created_at desc);

-- Só a service_role (API do agente) lê e grava: RLS ligada e sem política.
alter table public.agent_confirmations enable row level security;
alter table public.agent_audit_log enable row level security;
revoke all on public.agent_confirmations from anon, authenticated;
revoke all on public.agent_audit_log from anon, authenticated;

-- Limite de chamadas por janela (usa a tabela rate_limits que já existia). Devolve true se passou do limite.
create or replace function public.agent_rate_hit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  c int;
begin
  insert into rate_limits as r (key, window_start, count) values (p_key, now(), 1)
  on conflict (key) do update
     set count = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end,
         window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning count into c;
  return c > p_limit;
end $$;
revoke all on function public.agent_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.agent_rate_hit(text, int, int) to service_role;
