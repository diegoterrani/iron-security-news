-- LinkedIn pelo painel (§8.5): publicar o post da story no PERFIL de quem conectou (Share on LinkedIn,
-- w_member_social) e/ou na PÁGINA da IRON (Community Management API, w_organization_social).
--
-- O mesmo canal passa a ter mais de uma conta, então integrations e channel_posts ganham `target`:
--   'default'      → canais com uma conta só (blog, Instagram): nada muda para eles;
--   'member'       → LinkedIn, perfil pessoal;
--   'organization' → LinkedIn, página da empresa.
-- As chaves únicas passam a incluir `target`, e as funções que usam ON CONFLICT são recriadas com a chave nova.

alter table integrations  add column if not exists target text not null default 'default';
alter table channel_posts add column if not exists target text not null default 'default';

alter table integrations  drop constraint if exists integrations_target_check;
alter table integrations  add constraint integrations_target_check
  check (target in ('default', 'member', 'organization') and (channel = 'linkedin') = (target <> 'default'));
alter table channel_posts drop constraint if exists channel_posts_target_check;
alter table channel_posts add constraint channel_posts_target_check
  check (target in ('default', 'member', 'organization') and (channel = 'linkedin') = (target <> 'default'));

alter table integrations  drop constraint if exists integrations_brand_id_channel_lang_key;
alter table integrations  drop constraint if exists integrations_brand_channel_lang_target_key;
alter table integrations  add constraint integrations_brand_channel_lang_target_key unique (brand_id, channel, lang, target);
alter table channel_posts drop constraint if exists channel_posts_story_id_channel_lang_key;
alter table channel_posts drop constraint if exists channel_posts_story_channel_lang_target_key;
alter table channel_posts add constraint channel_posts_story_channel_lang_target_key unique (story_id, channel, lang, target);

-- Blog: mesma função, com a chave única nova no ON CONFLICT.
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
  on conflict (story_id, channel, lang, target) do nothing;
  get diagnostics n = row_count;
  update stories set status = 'SCHEDULED', scheduled_for = p_when
   where id = p_story and status = 'APPROVED'
     and exists (select 1 from channel_posts where story_id = p_story);
  return n;
end $$;

-- A assinatura muda (target, refresh token): recriar e não sobrecarregar, para o PostgREST não ficar
-- com duas funções de mesmo nome e argumentos com default (chamada ambígua).
drop function if exists public.integrations_list();
drop function if exists public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb);
drop function if exists public.integration_disconnect(channel, lang);
drop function if exists public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb, text, text);
drop function if exists public.integration_disconnect(channel, lang, text);

-- Lista o estado das integrações, sem nenhum campo de token.
create function public.integrations_list()
returns table (
  channel channel, lang lang, target text, account_name text, account_id text, status text,
  expires_at timestamptz, scopes text[], updated_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.review_guard('viewer');
  return query
    select i.channel, i.lang, i.target, i.account_name, i.account_id, i.status, i.expires_at, i.scopes, i.updated_at
      from integrations i
      join brands b on b.id = i.brand_id and b.slug = 'iron'
     order by i.channel, i.lang, i.target;
end $$;

-- Grava (ou substitui) a conta conectada. Tokens chegam já cifrados (base64 do AES-256-GCM v1).
create function public.integration_save(
  p_channel channel, p_lang lang, p_account_id text, p_account_name text,
  p_token_enc text, p_expires_at timestamptz, p_scopes text[], p_meta jsonb default '{}',
  p_target text default 'default', p_refresh_token_enc text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  brand uuid;
  token bytea;
  refresh bytea;
  rid uuid;
begin
  if p_channel = 'blog' then
    raise exception 'VALIDATION_ERROR: o blog não usa integração' using errcode = '22023';
  end if;
  if coalesce(p_target, '') not in ('default', 'member', 'organization')
     or (p_channel = 'linkedin') <> (p_target <> 'default') then
    raise exception 'VALIDATION_ERROR: alvo inválido' using errcode = '22023';
  end if;
  if coalesce(p_account_id, '') !~ '^[0-9A-Za-z:_.-]{1,100}$' or char_length(coalesce(btrim(p_account_name), '')) not between 1 and 100 then
    raise exception 'VALIDATION_ERROR: conta inválida' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'VALIDATION_ERROR: token já expirado' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_meta, '{}')) <> 'object' or octet_length(coalesce(p_meta, '{}')::text) > 4000 then
    raise exception 'VALIDATION_ERROR: meta inválido' using errcode = '22023';
  end if;
  begin
    token := decode(p_token_enc, 'base64');
    refresh := case when p_refresh_token_enc is null then null else decode(p_refresh_token_enc, 'base64') end;
  exception when others then
    raise exception 'VALIDATION_ERROR: token cifrado inválido' using errcode = '22023';
  end;
  -- v1 = 1 byte de versão + 12 de IV + 16 de tag + conteúdo. Rejeita token em texto puro por engano.
  if token is null or octet_length(token) < 30 or octet_length(token) > 8192 or get_byte(token, 0) <> 1 then
    raise exception 'VALIDATION_ERROR: token cifrado inválido' using errcode = '22023';
  end if;
  if refresh is not null and (octet_length(refresh) < 30 or octet_length(refresh) > 8192 or get_byte(refresh, 0) <> 1) then
    raise exception 'VALIDATION_ERROR: token cifrado inválido' using errcode = '22023';
  end if;
  select id into brand from brands where slug = 'iron';
  if brand is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into integrations (brand_id, channel, lang, target, account_name, account_id, access_token_enc,
                            refresh_token_enc, expires_at, scopes, status, meta)
  values (brand, p_channel, p_lang, p_target, btrim(p_account_name), p_account_id, token,
          refresh, p_expires_at, coalesce(p_scopes, '{}'), 'active', coalesce(p_meta, '{}'))
  on conflict (brand_id, channel, lang, target) do update set
    account_name = excluded.account_name, account_id = excluded.account_id,
    access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
    expires_at = excluded.expires_at, scopes = excluded.scopes, status = 'active', meta = excluded.meta
  returning id into rid;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'integration.connect', 'integration', rid::text,
          jsonb_build_object('channel', p_channel, 'lang', p_lang, 'target', p_target, 'account', btrim(p_account_name),
                             'account_id', p_account_id, 'expires_at', p_expires_at));
  return json_build_object('id', rid, 'status', 'active');
end $$;

-- Desconecta: apaga os tokens (não a linha, que channel_posts antigos referenciam) e marca disabled.
create function public.integration_disconnect(p_channel channel, p_lang lang, p_target text default 'default') returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  rid uuid;
begin
  update integrations i set access_token_enc = '\x'::bytea, refresh_token_enc = null, expires_at = null, status = 'disabled'
    from brands b
   where b.id = i.brand_id and b.slug = 'iron' and i.channel = p_channel and i.lang = p_lang and i.target = p_target
  returning i.id into rid;
  if rid is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'integration.disconnect', 'integration', rid::text, jsonb_build_object('channel', p_channel, 'lang', p_lang, 'target', p_target));
  return json_build_object('id', rid, 'status', 'disabled');
end $$;

-- Pede a publicação do post PT no LinkedIn (perfil ou página). Quem publica é o executor, que tem o token.
-- Regras no banco: admin + MFA, story aprovada, conta do alvo conectada e válida, texto e card prontos.
create or replace function public.review_publish_linkedin(p_story uuid, p_target text, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
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
  values (uid, 'post.publish_request', 'story', p_story::text,
          jsonb_build_object('channel', 'linkedin', 'target', p_target, 'lang', p_lang, 'version', ver));
  return json_build_object('id', post.id, 'status', 'pending');
end $$;

revoke all on function public.integrations_list() from public, anon;
revoke all on function public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb, text, text) from public, anon;
revoke all on function public.integration_disconnect(channel, lang, text) from public, anon;
revoke all on function public.review_publish_linkedin(uuid, text, lang) from public, anon;
grant execute on function public.integrations_list() to authenticated;
grant execute on function public.integration_save(channel, lang, text, text, text, timestamptz, text[], jsonb, text, text) to authenticated;
grant execute on function public.integration_disconnect(channel, lang, text) to authenticated;
grant execute on function public.review_publish_linkedin(uuid, text, lang) to authenticated;
revoke all on function public.schedule_blog_posts(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_blog_posts(uuid, timestamptz) to ironnews_exec;
