-- Ações de revisão do painel (§4.9). O painel chama estas funções com a sessão do usuário (supabase.rpc);
-- as regras ficam no banco: usuário logado, MFA nesta sessão (aal2), papel editor+, estado correto da story.
-- Toda ação humana vai para audit_log (§4.14).

create or replace function public.review_guard(min_role app_role) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA_REQUIRED' using errcode = '28000';
  end if;
  if not public.has_role(min_role) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return uid;
end $$;

create or replace function public.review_approve(p_story uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
  st story_status;
begin
  update stories set status = 'APPROVED', approved_by = uid, approved_at = now()
   where id = p_story and status = 'AWAITING_REVIEW'
  returning status into st;
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id) values (uid, 'story.approve', 'story', p_story::text);
  return json_build_object('id', p_story, 'status', st);
end $$;

create or replace function public.review_reject(p_story uuid, p_reason text) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
  reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(reason) < 3 or char_length(reason) > 500 then
    raise exception 'VALIDATION_ERROR: motivo entre 3 e 500 caracteres' using errcode = '22023';
  end if;
  update stories set status = 'REJECTED', rejected_by = uid, rejected_reason = reason
   where id = p_story and status = 'AWAITING_REVIEW';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'story.reject', 'story', p_story::text, jsonb_build_object('reason', reason));
  return json_build_object('id', p_story, 'status', 'REJECTED');
end $$;

-- Edição humana = nova versão (RN-GEN03). p_patch é mesclado sobre o corpo da versão mais recente.
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
  return json_build_object('id', p_story, 'version', next_version);
end $$;

revoke all on function public.review_guard(app_role) from public, anon, authenticated;
revoke all on function public.review_approve(uuid) from public, anon;
revoke all on function public.review_reject(uuid, text) from public, anon;
revoke all on function public.review_edit(uuid, channel, lang, text, text, jsonb) from public, anon;
grant execute on function public.review_approve(uuid) to authenticated;
grant execute on function public.review_reject(uuid, text) to authenticated;
grant execute on function public.review_edit(uuid, channel, lang, text, text, jsonb) to authenticated;
