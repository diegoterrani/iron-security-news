-- Notícia manual (pedido do Terrani em 17/11/2026).
--
-- O editor cola um link ou um texto em /admin/nova. A RPC manual_story_request (editor+MFA) só grava o
-- pedido; o executor na VPS o processa (busca o link com proteção contra SSRF, triagem, story DRAFTING) e
-- a story segue o MESMO caminho das demais: buildStory → Fact Guard → derivados → criativos → revisão.
-- Nada é publicado sem aprovação.

-- 1) Fonte "Envio manual": desativada, para a coleta e o test-sources nunca tentarem buscá-la.
insert into sources (brand_id, name, kind, url, lang, trust_weight, fetch_interval_min, enabled, config)
select b.id, 'Envio manual', 'manual'::source_kind, 'urn:ironnews:manual', 'pt'::lang, 0.80, 1440, false,
       '{"manual": true}'::jsonb
  from brands b
 where b.slug = 'iron'
on conflict (brand_id, url) do nothing;

-- 2) Nome do veículo exibido ao redator quando o item não vem de uma fonte cadastrada
--    (ex.: link da Reuters enviado à mão ⇒ "Reuters", e não "Envio manual").
alter table raw_items add column if not exists source_label text
  check (source_label is null or char_length(source_label) between 1 and 120);

-- 3) Pedidos
create table if not exists manual_requests (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  kind text not null check (kind in ('url', 'text')),
  input_url text check (input_url is null or char_length(input_url) <= 2048),
  input_text text check (input_text is null or char_length(input_text) <= 60000),
  source_name text check (source_name is null or char_length(source_name) <= 120),
  source_url text check (source_url is null or char_length(source_url) <= 2048),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts int not null default 0,
  story_id uuid references stories(id) on delete set null,
  error text check (error is null or char_length(error) <= 500),
  requested_by uuid references profiles(id),
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'url' and input_url is not null) or (kind = 'text' and input_text is not null))
);
create index if not exists manual_requests_pending_idx on manual_requests (created_at) where status in ('pending', 'processing');
create index if not exists manual_requests_recent_idx on manual_requests (brand_id, created_at desc);

alter table manual_requests enable row level security;
drop policy if exists read_manual_requests on manual_requests;
create policy read_manual_requests on manual_requests for select to authenticated using (has_role('editor'));
-- Escrita do painel só pela RPC abaixo (security definer); o executor usa ironnews_exec (bypassrls).
grant select, insert, update on manual_requests to ironnews_exec;
grant select on manual_requests to authenticated;

-- 4) RPC do painel
create or replace function public.manual_story_request(
  p_kind text, p_url text, p_text text, p_source_name text, p_source_url text
) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.review_guard('editor');
  brand uuid;
  url text := nullif(btrim(coalesce(p_url, '')), '');
  body text := nullif(btrim(coalesce(p_text, '')), '');
  sname text := nullif(btrim(coalesce(p_source_name, '')), '');
  surl text := nullif(btrim(coalesce(p_source_url, '')), '');
  rid uuid;
begin
  if p_kind not in ('url', 'text') then
    raise exception 'VALIDATION_ERROR: escolha link ou texto' using errcode = '22023';
  end if;
  -- Só https e sem credenciais na URL; o executor revalida (DNS, IP privado, redirecionamentos).
  if p_kind = 'url' and (url is null or char_length(url) > 2048 or url !~* '^https://[^\s/@]+(/[^\s]*)?$') then
    raise exception 'VALIDATION_ERROR: informe um link https válido' using errcode = '22023';
  end if;
  if p_kind = 'text' and (body is null or char_length(body) not between 200 and 60000) then
    raise exception 'VALIDATION_ERROR: o texto precisa ter entre 200 e 60.000 caracteres' using errcode = '22023';
  end if;
  if sname is not null and char_length(sname) > 120 then
    raise exception 'VALIDATION_ERROR: nome da fonte com até 120 caracteres' using errcode = '22023';
  end if;
  if surl is not null and (char_length(surl) > 2048 or surl !~* '^https?://[^\s/@]+(/[^\s]*)?$') then
    raise exception 'VALIDATION_ERROR: link da fonte inválido' using errcode = '22023';
  end if;
  select id into brand from brands where slug = 'iron';
  if brand is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Teto contra abuso e gasto de IA acidental: 5 na fila por vez e 30 por usuário em 24 h.
  if (select count(*) from manual_requests where brand_id = brand and status in ('pending', 'processing')) >= 5 then
    raise exception 'VALIDATION_ERROR: já há 5 pedidos em andamento; aguarde terminarem' using errcode = '22023';
  end if;
  if (select count(*) from manual_requests where requested_by = uid and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'VALIDATION_ERROR: limite de 30 pedidos em 24 h atingido' using errcode = '22023';
  end if;

  insert into manual_requests (brand_id, kind, input_url, input_text, source_name, source_url, requested_by)
  values (brand, p_kind,
          case when p_kind = 'url' then url end,
          case when p_kind = 'text' then body end,
          sname,
          case when p_kind = 'text' then surl end,
          uid)
  returning id into rid;
  insert into audit_log (actor, action, entity, entity_id, diff)
  values (uid, 'story.manual_request', 'manual_request', rid::text,
          jsonb_strip_nulls(jsonb_build_object('kind', p_kind, 'url', case when p_kind = 'url' then url end,
                                               'chars', case when p_kind = 'text' then char_length(body) end)));
  return json_build_object('id', rid, 'status', 'pending');
end $$;

revoke all on function public.manual_story_request(text, text, text, text, text) from public, anon;
grant execute on function public.manual_story_request(text, text, text, text, text) to authenticated;
