-- Extensões
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgmq;          -- Supabase Queues

-- Tipos
create type app_role     as enum ('admin','editor','viewer');
create type lang         as enum ('pt','en');
create type channel      as enum ('blog','instagram','facebook','linkedin','youtube');
create type source_kind  as enum ('rss','json_api','cisa_kev','nvd','github_advisory','ransomware_live');
create type severity     as enum ('critical','high','medium','low','info');
create type story_status as enum ('DRAFTING','AWAITING_REVIEW','APPROVED','SCHEDULED','PUBLISHING',
                                  'PUBLISHED','PARTIAL','REJECTED','FAILED');
create type item_status  as enum ('new','triaged','discarded');
create type asset_status as enum ('pending','rendering','ready','failed');
create type post_status  as enum ('pending','publishing','published','failed','skipped');

-- updated_at
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table brands (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  domain text not null,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  display_name text,
  role app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

create table settings (
  brand_id uuid primary key references brands(id) on delete cascade,
  timezone text not null default 'America/Sao_Paulo',
  posts_per_day int not null default 1 check (posts_per_day between 1 and 10),
  lead_time_min int not null default 120 check (lead_time_min between 30 and 480),
  min_score numeric(5,2) not null default 55,
  langs lang[] not null default '{pt,en}',
  channels_enabled channel[] not null default '{blog,instagram,facebook}',
  publish_times jsonb not null default
    '{"blog":["08:00"],"instagram":["12:00"],"facebook":["12:30"],"linkedin":["09:00"],"youtube":["18:00"]}',
  video_mode text not null default 'before_review' check (video_mode in ('before_review','after_approval')),
  llm_monthly_budget_usd numeric(10,2) not null default 15,
  ingest_default_interval_min int not null default 30,
  updated_at timestamptz not null default now()
);

create table sources (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  name text not null,
  kind source_kind not null,
  url text not null,
  lang lang not null default 'en',
  trust_weight numeric(3,2) not null default 0.6 check (trust_weight between 0 and 1),
  fetch_interval_min int not null default 30 check (fetch_interval_min >= 10),
  enabled boolean not null default true,
  config jsonb not null default '{}',
  etag text, last_modified text,
  last_fetched_at timestamptz, last_error text,
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, url)
);

create table clusters (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  title text not null,
  centroid vector(1024),
  cve_ids text[] not null default '{}',
  item_count int not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  relevance_max numeric(4,3) not null default 0,
  trust_max numeric(3,2) not null default 0,
  flags jsonb not null default '{}',     -- {in_kev, zero_day, exploited, brazil}
  top_score numeric(5,2) not null default 0,
  category text,
  blocked boolean not null default false
);

create table raw_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  cluster_id uuid references clusters(id) on delete set null,
  url text not null,
  canonical_url text not null,
  url_hash text not null unique,
  title text not null,
  summary text,
  content_excerpt text check (char_length(content_excerpt) <= 2000),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  lang lang,
  cve_ids text[] not null default '{}',
  embedding vector(1024),
  status item_status not null default 'new',
  triage jsonb,
  category text,
  severity severity,
  relevance numeric(4,3),
  discard_reason text
);

create table stories (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  cluster_id uuid unique references clusters(id),
  status story_status not null default 'DRAFTING',
  score numeric(5,2) not null,
  category text not null,
  severity severity not null,
  cve_ids text[] not null default '{}',
  facts jsonb not null default '{}',
  fact_guard jsonb not null default '{"passed":null,"issues":[]}',
  slug_pt text unique, slug_en text unique,
  tags text[] not null default '{}',
  scheduled_for timestamptz,
  published_at timestamptz,
  approved_by uuid references profiles(id), approved_at timestamptz,
  rejected_by uuid references profiles(id), rejected_reason text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table story_sources (
  story_id uuid references stories(id) on delete cascade,
  raw_item_id uuid references raw_items(id) on delete cascade,
  primary key (story_id, raw_item_id)
);

create table story_contents (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  channel channel not null,
  lang lang not null,
  kind text not null check (kind in ('article','post','carousel','script')),
  version int not null default 1,
  title text,
  body jsonb not null,
  search tsvector,
  edited_by uuid references profiles(id),      -- null = IA
  model text,                                   -- modelo que gerou (null se humano)
  prompt_version text,                          -- ex.: writer@3 (null se humano)
  created_at timestamptz not null default now(),
  unique (story_id, channel, lang, kind, version)
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  channel channel not null,
  lang lang not null,
  kind text not null check (kind in ('cover','carousel_slide','card','video','thumbnail')),
  position int not null default 1,
  status asset_status not null default 'pending',
  storage_path text, public_url text,
  mime text, width int, height int, duration_s numeric(6,2), bytes bigint,
  provider text check (provider in ('og-render','heygen')),
  provider_ref text,                 -- video_id HeyGen
  content_version int not null default 1,
  meta jsonb not null default '{}',  -- avatar_id, voice_id, erro
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, channel, lang, kind, position, content_version)
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references brands(id) on delete cascade,
  channel channel not null check (channel <> 'blog'),
  lang lang not null default 'pt',
  account_name text not null,
  account_id text not null,              -- ig-user-id, page-id, urn:li:organization:…, channelId
  access_token_enc bytea not null,
  refresh_token_enc bytea,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active','needs_reauth','disabled')),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, channel, lang)
);

create table channel_posts (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  channel channel not null,
  lang lang not null,
  integration_id uuid references integrations(id),
  status post_status not null default 'pending',
  scheduled_for timestamptz not null,
  content_version int not null,
  idempotency_key text not null unique,
  external_id text, external_url text,
  attempts int not null default 0,
  last_error text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, channel, lang)
);

create table heygen_pool (
  id uuid primary key default gen_random_uuid(),
  lang lang not null,
  avatar_id text not null, avatar_name text,
  avatar_type text not null default 'avatar' check (avatar_type in ('avatar','talking_photo')),
  voice_id text not null, voice_name text,
  weight int not null default 1 check (weight between 1 and 10),
  enabled boolean not null default true,
  last_used_at timestamptz,
  unique (lang, avatar_id, voice_id)
);

create table cve_cache (
  cve_id text primary key,
  nvd jsonb, epss jsonb, kev jsonb,
  exists_in_nvd boolean not null,
  fetched_at timestamptz not null default now()
);

create table llm_usage (
  id bigint generated always as identity primary key,
  story_id uuid references stories(id) on delete set null,
  task text not null,                  -- triage|write|derive|regenerate|factcheck
  model text not null,
  input_tokens int not null, output_tokens int not null,
  cache_read_tokens int not null default 0, cache_write_tokens int not null default 0,
  batch boolean not null default false,
  cost_usd numeric(10,6) not null,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor uuid references profiles(id),   -- null = sistema
  action text not null,                 -- story.approve, content.edit, settings.update…
  entity text not null, entity_id text,
  diff jsonb, ip inet, trace_id text,
  created_at timestamptz not null default now()
);

create table rate_limits (
  key text primary key, window_start timestamptz not null, count int not null
);

-- Triggers updated_at
create trigger t_sources_upd   before update on sources       for each row execute function set_updated_at();
create trigger t_stories_upd   before update on stories       for each row execute function set_updated_at();
create trigger t_assets_upd    before update on assets        for each row execute function set_updated_at();
create trigger t_integr_upd    before update on integrations  for each row execute function set_updated_at();
create trigger t_posts_upd     before update on channel_posts for each row execute function set_updated_at();
create trigger t_settings_upd  before update on settings      for each row execute function set_updated_at();

-- Busca full-text do blog
create or replace function story_contents_search() returns trigger language plpgsql as $$
begin
  if new.kind = 'article' then
    new.search := to_tsvector(case when new.lang = 'pt' then 'portuguese'::regconfig else 'english'::regconfig end,
                              coalesce(new.title,'') || ' ' || coalesce(new.body->>'tldr','') || ' ' || coalesce(new.body->>'markdown',''));
  end if;
  return new;
end $$;
create trigger t_contents_search before insert or update on story_contents
  for each row execute function story_contents_search();

-- Filas
select pgmq.create('triage');
select pgmq.create('story_build');
select pgmq.create('render');
select pgmq.create('video');
select pgmq.create('video_events');
select pgmq.create('publish');
select pgmq.create('dlq');
