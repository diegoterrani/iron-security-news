-- Campanhas pelo painel: publicar peças prontas (vídeo, carrossel de imagens, PDF) que NÃO nascem de uma
-- story, como a campanha do Cyber Assessment. O admin sobe o arquivo para o Storage, escolhe o destino e o
-- horário; o executor publica na hora marcada com o token já conectado em Integrações.
--
-- Destinos (channel / target / format):
--   instagram / default      / reel      → 1 vídeo MP4 (Reels, também no feed)
--   instagram / default      / carousel  → 2 a 10 imagens JPEG ou PNG
--   linkedin  / member|organization / video    → 1 vídeo MP4
--   linkedin  / member|organization / document → 1 PDF (carrossel do LinkedIn)
--   linkedin  / member|organization / image    → 1 imagem JPEG ou PNG
--
-- Segurança:
--   - upload direto do navegador para media/campanhas/<uuid>/…, só admin com MFA (policy no storage.objects);
--   - a RPC confere que cada arquivo existe, é do próprio usuário, tem extensão e tamanho aceitos;
--   - a tabela só é lida pelo painel (viewer+); escrita só pelas RPCs (admin + MFA) e pelo executor.

create table if not exists public.campaign_posts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id),
  campaign text not null check (char_length(btrim(campaign)) between 1 and 80),
  channel channel not null check (channel in ('instagram', 'linkedin')),
  target text not null,
  format text not null,
  caption text not null check (char_length(caption) between 1 and 3000),
  first_comment text check (first_comment is null or char_length(first_comment) between 1 and 1250),
  doc_title text check (doc_title is null or char_length(doc_title) between 1 and 200),
  media text[] not null check (cardinality(media) between 1 and 10),
  integration_id uuid references integrations(id),
  status post_status not null default 'pending',
  scheduled_for timestamptz not null,
  attempts int not null default 0,
  external_id text,
  external_url text,
  last_error text,
  published_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_posts_target_check
    check (target in ('default', 'member', 'organization') and (channel = 'linkedin') = (target <> 'default')),
  constraint campaign_posts_format_check
    check ((channel = 'instagram' and format in ('reel', 'carousel'))
        or (channel = 'linkedin' and format in ('video', 'document', 'image')))
);
create index if not exists campaign_posts_due on public.campaign_posts (status, scheduled_for);
create index if not exists campaign_posts_recent on public.campaign_posts (scheduled_for desc);

drop trigger if exists t_campaign_posts_upd on public.campaign_posts;
create trigger t_campaign_posts_upd before update on public.campaign_posts for each row execute function set_updated_at();

alter table public.campaign_posts enable row level security;
drop policy if exists read_campaign_posts on public.campaign_posts;
create policy read_campaign_posts on public.campaign_posts for select to authenticated using (has_role('viewer'));
-- O Supabase dá ALL em tabela nova para anon/authenticated por padrão: o painel só lê.
revoke all on public.campaign_posts from anon;
revoke insert, update, delete, truncate, references, trigger on public.campaign_posts from authenticated;
grant select on public.campaign_posts to authenticated, ironnews_web;
grant select, insert, update on public.campaign_posts to ironnews_exec;

-- Quem pode subir arquivo de campanha: admin com MFA (mesma regra das RPCs review_*; aqui sem exceção,
-- porque a policy precisa de um booleano).
create or replace function public.campaign_upload_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and public.has_role('admin')
$$;
revoke all on function public.campaign_upload_allowed() from public, anon;
grant execute on function public.campaign_upload_allowed() to authenticated;

-- Upload só dentro de media/campanhas/<uuid>/<arquivo>.<mp4|jpg|jpeg|png|pdf>. Sem update/delete pelo navegador:
-- um arquivo já agendado não pode ser trocado por baixo da publicação.
drop policy if exists campaign_media_insert on storage.objects;
create policy campaign_media_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and name ~ '^campanhas/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}\.(mp4|jpg|jpeg|png|pdf)$'
    and public.campaign_upload_allowed()
  );

-- Agenda uma publicação de campanha. Todas as regras ficam aqui (o painel só repete para dar a mensagem).
create or replace function public.campaign_post_create(
  p_campaign text, p_channel channel, p_target text, p_format text, p_caption text,
  p_media text[], p_scheduled_for timestamptz default null,
  p_first_comment text default null, p_doc_title text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  brand uuid;
  integ uuid;
  rid uuid;
  path text;
  ext text;
  sz bigint;
  n int := coalesce(cardinality(p_media), 0);
  allowed text[];
  max_bytes bigint;
  max_caption int := case when p_channel = 'instagram' then 2200 else 3000 end;
  when_ts timestamptz := coalesce(p_scheduled_for, now());
  where_label text := case p_target when 'member' then 'no perfil' when 'organization' then 'na página' else '' end;
begin
  if p_channel not in ('instagram', 'linkedin')
     or coalesce(p_target, '') not in ('default', 'member', 'organization')
     or (p_channel = 'linkedin') <> (p_target <> 'default') then
    raise exception 'VALIDATION_ERROR: destino inválido' using errcode = '22023';
  end if;

  -- Formato → arquivos aceitos, quantidade e tamanho máximo (limites das APIs, com folga).
  case
    when p_channel = 'instagram' and p_format = 'reel' then
      allowed := array['mp4']; max_bytes := 300 * 1024 * 1024;
      if n <> 1 then raise exception 'VALIDATION_ERROR: o Reels leva 1 vídeo MP4' using errcode = '22023'; end if;
    when p_channel = 'instagram' and p_format = 'carousel' then
      allowed := array['jpg', 'jpeg', 'png']; max_bytes := 8 * 1024 * 1024;
      if n not between 2 and 10 then raise exception 'VALIDATION_ERROR: o carrossel do Instagram leva de 2 a 10 imagens' using errcode = '22023'; end if;
    when p_channel = 'linkedin' and p_format = 'video' then
      allowed := array['mp4']; max_bytes := 500 * 1024 * 1024;
      if n <> 1 then raise exception 'VALIDATION_ERROR: o vídeo do LinkedIn leva 1 arquivo MP4' using errcode = '22023'; end if;
    when p_channel = 'linkedin' and p_format = 'document' then
      allowed := array['pdf']; max_bytes := 100 * 1024 * 1024;
      if n <> 1 then raise exception 'VALIDATION_ERROR: o carrossel do LinkedIn leva 1 PDF' using errcode = '22023'; end if;
      if char_length(btrim(coalesce(p_doc_title, ''))) not between 1 and 200 then
        raise exception 'VALIDATION_ERROR: dê um título ao documento (aparece no LinkedIn)' using errcode = '22023';
      end if;
    when p_channel = 'linkedin' and p_format = 'image' then
      allowed := array['jpg', 'jpeg', 'png']; max_bytes := 8 * 1024 * 1024;
      if n <> 1 then raise exception 'VALIDATION_ERROR: o post com imagem leva 1 imagem' using errcode = '22023'; end if;
    else
      raise exception 'VALIDATION_ERROR: formato inválido para o destino' using errcode = '22023';
  end case;

  if char_length(btrim(coalesce(p_campaign, ''))) not between 1 and 80 then
    raise exception 'VALIDATION_ERROR: dê um nome à campanha (até 80 caracteres)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_caption, ''))) not between 1 and max_caption then
    raise exception 'VALIDATION_ERROR: a legenda precisa ter de 1 a % caracteres', max_caption using errcode = '22023';
  end if;
  if p_first_comment is not null and (p_channel <> 'linkedin' or char_length(btrim(p_first_comment)) not between 1 and 1250) then
    raise exception 'VALIDATION_ERROR: o 1º comentário é só para o LinkedIn, com até 1.250 caracteres' using errcode = '22023';
  end if;
  if when_ts < now() - interval '5 minutes' or when_ts > now() + interval '60 days' then
    raise exception 'VALIDATION_ERROR: escolha um horário entre agora e os próximos 60 dias' using errcode = '22023';
  end if;

  -- Cada arquivo: caminho da campanha, extensão do formato, enviado por este usuário, tamanho dentro do limite.
  foreach path in array p_media loop
    if path is null or path !~ '^campanhas/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}\.(mp4|jpg|jpeg|png|pdf)$' then
      raise exception 'VALIDATION_ERROR: arquivo inválido' using errcode = '22023';
    end if;
    ext := lower(substring(path from '\.([A-Za-z0-9]+)$'));
    if not ext = any(allowed) then
      raise exception 'VALIDATION_ERROR: arquivo .% não serve para este formato', ext using errcode = '22023';
    end if;
    select coalesce((o.metadata ->> 'size')::bigint, 0) into sz
      from storage.objects o
     where o.bucket_id = 'media' and o.name = path and o.owner_id = uid::text;
    if not found then
      raise exception 'VALIDATION_ERROR: arquivo não encontrado no Storage (envie de novo)' using errcode = '22023';
    end if;
    if sz <= 0 or sz > max_bytes then
      raise exception 'VALIDATION_ERROR: arquivo com tamanho fora do limite (até % MB)', max_bytes / 1024 / 1024 using errcode = '22023';
    end if;
  end loop;

  select id into brand from brands where slug = 'iron';
  select i.id into integ from integrations i
   where i.brand_id = brand and i.channel = p_channel and i.lang = 'pt' and i.target = p_target
     and i.status = 'active' and (i.expires_at is null or i.expires_at > when_ts);
  if integ is null then
    raise exception 'VALIDATION_ERROR: nenhuma conta % conectada % válida até o horário escolhido (Integrações)',
      case when p_channel = 'instagram' then 'do Instagram' else 'do LinkedIn' end, where_label using errcode = '22023';
  end if;

  insert into campaign_posts (brand_id, campaign, channel, target, format, caption, first_comment, doc_title, media,
                              integration_id, scheduled_for, created_by)
  values (brand, btrim(p_campaign), p_channel, p_target, p_format, btrim(p_caption), nullif(btrim(p_first_comment), ''),
          nullif(btrim(p_doc_title), ''), p_media, integ, when_ts, uid)
  returning id into rid;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'campaign.schedule', 'campaign_post', rid::text,
          jsonb_build_object('campaign', btrim(p_campaign), 'channel', p_channel, 'target', p_target, 'format', p_format,
                             'scheduled_for', when_ts, 'files', n));
  return json_build_object('id', rid, 'status', 'pending', 'scheduled_for', when_ts);
end $$;

-- Cancela uma publicação que ainda não saiu.
create or replace function public.campaign_post_cancel(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
begin
  update campaign_posts set status = 'skipped', last_error = 'Cancelada no painel.'
   where id = p_id and status = 'pending';
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id) values (uid, 'campaign.cancel', 'campaign_post', p_id::text);
  return json_build_object('id', p_id, 'status', 'skipped');
end $$;

-- Tenta de novo uma publicação que falhou ou foi cancelada (sai em até 1 minuto).
create or replace function public.campaign_post_retry(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
begin
  update campaign_posts set status = 'pending', scheduled_for = now(), last_error = null
   where id = p_id and status in ('failed', 'skipped');
  if not found then
    raise exception 'INVALID_STATE' using errcode = 'P0001';
  end if;
  insert into audit_log (actor, action, entity, entity_id) values (uid, 'campaign.retry', 'campaign_post', p_id::text);
  return json_build_object('id', p_id, 'status', 'pending');
end $$;

revoke all on function public.campaign_post_create(text, channel, text, text, text, text[], timestamptz, text, text) from public, anon;
revoke all on function public.campaign_post_cancel(uuid) from public, anon;
revoke all on function public.campaign_post_retry(uuid) from public, anon;
grant execute on function public.campaign_post_create(text, channel, text, text, text, text[], timestamptz, text, text) to authenticated;
grant execute on function public.campaign_post_cancel(uuid) to authenticated;
grant execute on function public.campaign_post_retry(uuid) to authenticated;
