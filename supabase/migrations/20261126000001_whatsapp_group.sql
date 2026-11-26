-- Grupo do WhatsApp (pedido do Terrani em 26/11/2026): botão "Enviar ao grupo do WhatsApp" na story.
--
-- Quem envia é o número "admin" do OpenClaw (gateway na VPS, só em loopback). O executor roda em container
-- e não alcança o gateway, então o envio é dividido:
--   painel → RPC review_publish_whatsapp (admin + MFA) → linha 'pending' em whatsapp_posts;
--   VPS → infra/vps/whatsapp-relay.sh (timer systemd) → `node dist/whatsapp-relay.js claim` no container
--         (monta capa + legenda) → `openclaw message send` → `done` / `fail`.
-- O ID do grupo e a conta ficam só na VPS (/etc/ironnews/whatsapp-relay.env), nunca no banco.

create table if not exists whatsapp_posts (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  lang lang not null default 'pt',
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts int not null default 0,
  message_id text check (message_id is null or char_length(message_id) <= 200),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  requested_by uuid references profiles(id),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, lang)
);
create index if not exists whatsapp_posts_pending_idx on whatsapp_posts (requested_at) where status in ('pending', 'sending');

drop trigger if exists t_whatsapp_posts_upd on whatsapp_posts;
create trigger t_whatsapp_posts_upd before update on whatsapp_posts for each row execute function set_updated_at();

alter table whatsapp_posts enable row level security;
drop policy if exists read_whatsapp_posts on whatsapp_posts;
create policy read_whatsapp_posts on whatsapp_posts for select to authenticated using (has_role('viewer'));
-- Escrita do painel só pela RPC abaixo (security definer); o executor usa ironnews_exec (bypassrls).
grant select on whatsapp_posts to authenticated;
grant select, update on whatsapp_posts to ironnews_exec;

-- Pede o envio da story ao grupo. Regras: admin + MFA, artigo PT já publicado no blog (o link precisa
-- abrir), capa pronta, um envio por story e no máximo 10 pedidos em 24 h (anti-spam: o número é pessoal,
-- não da API oficial, e o WhatsApp bloqueia contas que disparam demais).
create or replace function public.review_publish_whatsapp(p_story uuid, p_lang lang default 'pt') returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('admin');
  blog_url text;
  cover int;
  recent int;
  post whatsapp_posts;
  has_post boolean;
begin
  if not exists (select 1 from stories where id = p_story) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select external_url into blog_url from channel_posts
   where story_id = p_story and channel = 'blog' and lang = p_lang and status = 'published' and external_url is not null;
  if blog_url is null then
    raise exception 'VALIDATION_ERROR: publique o artigo no blog antes de enviar ao WhatsApp' using errcode = '22023';
  end if;
  select count(*) into cover from assets
   where story_id = p_story and channel = 'blog' and lang = p_lang and kind = 'cover' and status = 'ready';
  if cover = 0 then
    raise exception 'VALIDATION_ERROR: a capa do blog ainda não está pronta' using errcode = '22023';
  end if;

  select * into post from whatsapp_posts where story_id = p_story and lang = p_lang for update;
  has_post := found;
  if has_post then
    if post.status = 'sent' then
      raise exception 'VALIDATION_ERROR: já enviado ao grupo do WhatsApp' using errcode = '22023';
    elsif post.status in ('pending', 'sending') then
      return json_build_object('id', post.id, 'status', post.status);
    end if;
  end if;

  select count(*) into recent from audit_log
   where action = 'post.whatsapp_request' and created_at > now() - interval '24 hours';
  if recent >= 10 then
    raise exception 'VALIDATION_ERROR: limite de 10 envios ao WhatsApp em 24 h atingido' using errcode = '22023';
  end if;

  if has_post then
    -- failed: reabre (o operador já conferiu no grupo que não saiu).
    update whatsapp_posts set status = 'pending', last_error = null, requested_by = uid, requested_at = now(), claimed_at = null
     where id = post.id;
  else
    insert into whatsapp_posts (story_id, lang, requested_by) values (p_story, p_lang, uid) returning * into post;
  end if;

  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'post.whatsapp_request', 'story', p_story::text, jsonb_build_object('channel', 'whatsapp', 'lang', p_lang));
  return json_build_object('id', post.id, 'status', 'pending');
end $$;

revoke all on function public.review_publish_whatsapp(uuid, lang) from public, anon;
grant execute on function public.review_publish_whatsapp(uuid, lang) to authenticated;
