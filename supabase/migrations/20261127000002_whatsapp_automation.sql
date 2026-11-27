-- Grupo do WhatsApp: além das stories do blog, a fila aceita um TEXTO PRONTO com horário marcado,
-- agendado pela automação (Plantão Cyber 18h: manchetes + link do episódio no YouTube).
-- Reaproveita o envio que já existe (infra/vps/whatsapp-relay.sh + OpenClaw), o mesmo número e o mesmo
-- grupo (WA_GROUP_JID só na VPS). Sem imagem: o WhatsApp monta a prévia do link.
--
-- Escopo mínimo: a função é só da service_role (rota /api/automation/v1/whatsapp-group, token + HMAC
-- próprios), o admin vem de AUTOMATION_ACTOR e é conferido aqui, e o teto de 10 envios em 24 h vale para
-- os dois tipos juntos (o número é pessoal; o WhatsApp bloqueia quem dispara demais).

alter table public.whatsapp_posts alter column story_id drop not null;
alter table public.whatsapp_posts add column if not exists body text;
alter table public.whatsapp_posts add column if not exists send_after timestamptz not null default now();
alter table public.whatsapp_posts add column if not exists dedupe_key text;

alter table public.whatsapp_posts drop constraint if exists whatsapp_posts_kind_check;
alter table public.whatsapp_posts add constraint whatsapp_posts_kind_check
  check ((story_id is null) = (body is not null));
alter table public.whatsapp_posts drop constraint if exists whatsapp_posts_body_check;
alter table public.whatsapp_posts add constraint whatsapp_posts_body_check
  check (body is null or char_length(btrim(body)) between 1 and 1500);
alter table public.whatsapp_posts drop constraint if exists whatsapp_posts_dedupe_key_check;
alter table public.whatsapp_posts add constraint whatsapp_posts_dedupe_key_check
  check (dedupe_key is null or dedupe_key ~ '^[a-z0-9][a-z0-9._-]{2,79}$');
create unique index if not exists whatsapp_posts_dedupe_key on public.whatsapp_posts (dedupe_key) where dedupe_key is not null;

drop index if exists whatsapp_posts_pending_idx;
create index if not exists whatsapp_posts_pending_idx on public.whatsapp_posts (send_after, requested_at)
  where status in ('pending', 'sending');

create or replace function public.automation_whatsapp_group_create(
  p_actor uuid, p_body text, p_send_after timestamptz, p_dedupe_key text
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.agent_actor(p_actor);
  existing record;
  recent int;
  rid uuid;
begin
  if p_dedupe_key is null or p_dedupe_key !~ '^[a-z0-9][a-z0-9._-]{2,79}$' then
    raise exception 'VALIDATION_ERROR: dedupe_key inválida (a-z, 0-9, ponto, _ e -, 3 a 80)' using errcode = '22023';
  end if;

  -- Mesma chave = mesmo pedido: devolve o que já existe, sem enfileirar de novo.
  select id, status, send_after into existing from whatsapp_posts where dedupe_key = p_dedupe_key;
  if found then
    return json_build_object('id', existing.id, 'status', existing.status, 'send_after', existing.send_after,
                             'duplicate', true);
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 1500 then
    raise exception 'VALIDATION_ERROR: a mensagem precisa ter de 1 a 1.500 caracteres' using errcode = '22023';
  end if;
  if p_send_after is null or p_send_after < now() - interval '5 minutes' or p_send_after > now() + interval '7 days' then
    raise exception 'VALIDATION_ERROR: escolha um horário entre agora e os próximos 7 dias' using errcode = '22023';
  end if;

  select count(*) into recent from audit_log
   where action = 'post.whatsapp_request' and created_at > now() - interval '24 hours';
  if recent >= 10 then
    raise exception 'VALIDATION_ERROR: limite de 10 envios ao WhatsApp em 24 h atingido' using errcode = '22023';
  end if;

  insert into whatsapp_posts (story_id, lang, body, send_after, dedupe_key, requested_by)
  values (null, 'pt', btrim(p_body), p_send_after, p_dedupe_key, uid)
  returning id into rid;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'post.whatsapp_request', 'whatsapp_post', rid::text,
          jsonb_build_object('channel', 'whatsapp', 'send_after', p_send_after, 'dedupe_key', p_dedupe_key,
                             'chars', char_length(btrim(p_body)), 'via', 'automation'));
  return json_build_object('id', rid, 'status', 'pending', 'send_after', p_send_after, 'duplicate', false);
end $$;

revoke all on function public.automation_whatsapp_group_create(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.automation_whatsapp_group_create(uuid, text, timestamptz, text) to service_role;
