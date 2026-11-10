-- Criativos (§4.7): editar um texto no painel pede nova renderização das imagens (fila `render`).
-- O executor também enfileira ao terminar a geração da story.

create or replace function public.review_edit(
  p_story uuid, p_channel channel, p_lang lang, p_kind text, p_title text, p_patch jsonb
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
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
          cur.body || p_patch, uid, null, null);
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'content.edit', 'story_content', p_story::text,
          jsonb_build_object('channel', p_channel, 'lang', p_lang, 'kind', p_kind, 'version', next_version,
                             'fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));
  -- Título do artigo, slides, cartão e gancho do Short aparecem nas imagens: renderiza de novo.
  if p_channel in ('blog', 'instagram', 'linkedin', 'youtube') then
    perform pgmq.send('render'::text,
      jsonb_build_object('v', 1, 'traceId', gen_random_uuid()::text, 'attempt', 1, 'payload', jsonb_build_object('story_id', p_story)),
      0::integer);
  end if;
  return json_build_object('id', p_story, 'version', next_version);
end $$;

revoke all on function public.review_edit(uuid, channel, lang, text, text, jsonb) from public, anon;
grant execute on function public.review_edit(uuid, channel, lang, text, text, jsonb) to authenticated;

-- Stories que já têm conteúdo ganham seus criativos.
select pgmq.send('render'::text,
  jsonb_build_object('v', 1, 'traceId', gen_random_uuid()::text, 'attempt', 1, 'payload', jsonb_build_object('story_id', id)),
  0::integer)
  from stories
 where status in ('AWAITING_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL');
