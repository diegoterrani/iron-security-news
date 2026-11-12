-- Publicar o carrossel no Instagram a partir do painel (§4.10, §8.4).
-- O painel só PEDE a publicação (cria/reabre o channel_post); quem publica é o executor, que tem o token.
-- Regras no banco: admin + MFA (review_guard), story já aprovada, conta conectada e válida, carrossel pronto.

create or replace function public.review_publish_instagram(p_story uuid, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
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
  values (uid, 'post.publish_request', 'story', p_story::text, jsonb_build_object('channel', 'instagram', 'lang', p_lang, 'version', ver));
  return json_build_object('id', post.id, 'status', 'pending');
end $$;

revoke all on function public.review_publish_instagram(uuid, lang) from public, anon;
grant execute on function public.review_publish_instagram(uuid, lang) to authenticated;
