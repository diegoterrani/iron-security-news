-- Fundo por IA sob demanda (pedido do Terrani em 24/11/2026: "pra economizar token").
--
-- Antes: toda story pronta gerava a ilustração de fundo (LLM + FLUX) automaticamente.
-- Agora: os criativos saem com fundo liso; o editor decide na revisão, pelo botão
-- "Gerar imagem de fundo com IA" na aba Criativos, que chama esta RPC. Ela invalida o fundo
-- atual (se houver, para permitir gerar outro) e pede ao executor que refaça os criativos
-- gerando a imagem. Teto de 3 pedidos por story em 24 h contra clique repetido e gasto acidental.

create or replace function public.review_request_background(p_story uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
  st story_status;
  recent int;
begin
  select status into st from stories where id = p_story;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if st not in ('AWAITING_REVIEW', 'APPROVED', 'SCHEDULED') then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  select count(*) into recent from audit_log
   where action = 'story.background_request' and entity_id = p_story::text and created_at > now() - interval '24 hours';
  if recent >= 3 then
    raise exception 'VALIDATION_ERROR: limite de 3 imagens por notícia em 24 h atingido' using errcode = '22023';
  end if;

  update assets set status = 'failed', meta = meta || jsonb_build_object('replaced_by_request', now())
   where story_id = p_story and kind = 'background' and status = 'ready';
  perform pgmq.send('render'::text,
    jsonb_build_object('v', 1, 'traceId', p_story::text, 'attempt', 1,
                       'payload', jsonb_build_object('story_id', p_story, 'background', 'generate')),
    0::integer);
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'story.background_request', 'story', p_story::text, jsonb_build_object('status', st));
  return json_build_object('id', p_story, 'status', 'queued');
end $$;

revoke all on function public.review_request_background(uuid) from public, anon;
grant execute on function public.review_request_background(uuid) to authenticated;
