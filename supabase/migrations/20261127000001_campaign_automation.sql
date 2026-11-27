-- Automação de campanhas: o agendamento diário do Plantão Cyber (fora do painel, sem navegador) agenda
-- o vídeo do dia no perfil do LinkedIn pela tela Campanhas, sem passar pela sessão de um admin com MFA.
--
-- Escopo mínimo de propósito: SÓ vídeo MP4, SÓ no LinkedIn, SÓ no perfil (target 'member').
-- Quem chama é a rota /api/automation/v1/* (service_role, com token e HMAC próprios); a função não é
-- executável por anon/authenticated. O admin em nome de quem a automação age vem de AUTOMATION_ACTOR e
-- é conferido aqui (agent_actor), então rebaixar o perfil corta a automação na hora.
--
-- Arquivos da automação ficam em media/campanhas/auto/<uuid>/video.mp4. A policy de upload do navegador
-- (campaign_media_insert) só aceita campanhas/<uuid>/…, então o painel não escreve nesse prefixo, e a
-- automação não escreve fora dele (a URL de upload assinada é gerada pelo servidor para um caminho fixo).

-- Idempotência: a mesma chave (ex.: 'plantao-2026-11-27-linkedin') nunca agenda duas vezes.
alter table public.campaign_posts add column if not exists dedupe_key text;
alter table public.campaign_posts drop constraint if exists campaign_posts_dedupe_key_check;
alter table public.campaign_posts add constraint campaign_posts_dedupe_key_check
  check (dedupe_key is null or dedupe_key ~ '^[a-z0-9][a-z0-9._-]{2,79}$');
create unique index if not exists campaign_posts_dedupe_key on public.campaign_posts (dedupe_key) where dedupe_key is not null;

create or replace function public.automation_linkedin_video_create(
  p_actor uuid, p_campaign text, p_caption text, p_media text, p_scheduled_for timestamptz, p_dedupe_key text,
  p_first_comment text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.agent_actor(p_actor);
  brand uuid;
  integ uuid;
  rid uuid;
  sz bigint;
  mime text;
  existing record;
  max_bytes constant bigint := 500 * 1024 * 1024;
begin
  if p_dedupe_key is null or p_dedupe_key !~ '^[a-z0-9][a-z0-9._-]{2,79}$' then
    raise exception 'VALIDATION_ERROR: dedupe_key inválida (a-z, 0-9, ponto, _ e -, 3 a 80)' using errcode = '22023';
  end if;

  -- Mesma chave = mesmo pedido: devolve o que já existe, sem criar outro post (reenvio seguro).
  select id, status, scheduled_for into existing from campaign_posts where dedupe_key = p_dedupe_key;
  if found then
    return json_build_object('id', existing.id, 'status', existing.status, 'scheduled_for', existing.scheduled_for,
                             'duplicate', true);
  end if;

  if char_length(btrim(coalesce(p_campaign, ''))) not between 1 and 80 then
    raise exception 'VALIDATION_ERROR: dê um nome à campanha (até 80 caracteres)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_caption, ''))) not between 1 and 3000 then
    raise exception 'VALIDATION_ERROR: a legenda precisa ter de 1 a 3000 caracteres' using errcode = '22023';
  end if;
  if p_first_comment is not null and char_length(btrim(p_first_comment)) not between 1 and 1250 then
    raise exception 'VALIDATION_ERROR: o 1º comentário precisa ter de 1 a 1.250 caracteres' using errcode = '22023';
  end if;
  if p_scheduled_for is null or p_scheduled_for < now() - interval '5 minutes' or p_scheduled_for > now() + interval '7 days' then
    raise exception 'VALIDATION_ERROR: escolha um horário entre agora e os próximos 7 dias' using errcode = '22023';
  end if;

  if p_media is null or p_media !~ '^campanhas/auto/[0-9a-f-]{36}/video\.mp4$' then
    raise exception 'VALIDATION_ERROR: arquivo inválido (use o caminho devolvido pelo upload)' using errcode = '22023';
  end if;
  select coalesce((o.metadata ->> 'size')::bigint, 0), lower(coalesce(o.metadata ->> 'mimetype', ''))
    into sz, mime
    from storage.objects o
   where o.bucket_id = 'media' and o.name = p_media;
  if not found then
    raise exception 'VALIDATION_ERROR: arquivo não encontrado no Storage (envie de novo)' using errcode = '22023';
  end if;
  if sz <= 0 or sz > max_bytes then
    raise exception 'VALIDATION_ERROR: vídeo com tamanho fora do limite (até 500 MB)' using errcode = '22023';
  end if;
  if mime <> 'video/mp4' then
    raise exception 'VALIDATION_ERROR: o arquivo precisa ser video/mp4' using errcode = '22023';
  end if;

  select id into brand from brands where slug = 'iron';
  select i.id into integ from integrations i
   where i.brand_id = brand and i.channel = 'linkedin' and i.lang = 'pt' and i.target = 'member'
     and i.status = 'active' and (i.expires_at is null or i.expires_at > p_scheduled_for);
  if integ is null then
    raise exception 'VALIDATION_ERROR: nenhuma conta do LinkedIn conectada no perfil válida até o horário escolhido (Integrações)'
      using errcode = '22023';
  end if;

  insert into campaign_posts (brand_id, campaign, channel, target, format, caption, first_comment, media,
                              integration_id, scheduled_for, created_by, dedupe_key)
  values (brand, btrim(p_campaign), 'linkedin', 'member', 'video', btrim(p_caption), nullif(btrim(p_first_comment), ''),
          array[p_media], integ, p_scheduled_for, uid, p_dedupe_key)
  returning id into rid;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'campaign.schedule', 'campaign_post', rid::text,
          jsonb_build_object('campaign', btrim(p_campaign), 'channel', 'linkedin', 'target', 'member', 'format', 'video',
                             'scheduled_for', p_scheduled_for, 'files', 1, 'dedupe_key', p_dedupe_key, 'via', 'automation'));
  return json_build_object('id', rid, 'status', 'pending', 'scheduled_for', p_scheduled_for, 'duplicate', false);
end $$;

revoke all on function public.automation_linkedin_video_create(uuid, text, text, text, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.automation_linkedin_video_create(uuid, text, text, text, timestamptz, text, text)
  to service_role;
