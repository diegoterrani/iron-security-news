-- Triagem (Message Batches) e seleção diária (§4.3, §4.4).

-- Lotes enviados à Message Batches API ainda em processamento.
create table llm_batches (
  id text primary key,                       -- id do lote na Anthropic (msgbatch_…)
  task text not null check (task in ('triage')),
  status text not null default 'in_progress' check (status in ('in_progress','ended','failed')),
  item_ids uuid[] not null,
  error text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index llm_batches_open on llm_batches (created_at) where status = 'in_progress';

-- Execuções únicas por chave (ex.: seleção uma vez por dia local). A chave primária garante idempotência.
create table scheduler_runs (
  job text not null,
  run_key text not null,
  ran_at timestamptz not null default now(),
  detail jsonb not null default '{}',
  primary key (job, run_key)
);

alter table llm_batches    enable row level security;
alter table scheduler_runs enable row level security;
create policy read_batches on llm_batches    for select to authenticated using (has_role('admin'));
create policy read_runs    on scheduler_runs for select to authenticated using (has_role('viewer'));

grant select, insert, update, delete on llm_batches, scheduler_runs to ironnews_exec;
grant select on llm_batches, scheduler_runs to ironnews_web;

-- Itens novos aguardando triagem, sem varrer a tabela inteira.
create index if not exists raw_items_new on raw_items (fetched_at) where status = 'new';

-- Score do cluster (RN-TRI05), 0–100. A recência depende de now(), então é calculado na hora.
create or replace function public.cluster_score(c public.clusters) returns numeric
language sql stable set search_path = public as $$
  select round(100 * (
      0.45 * c.relevance_max
    + 0.20 * c.trust_max
    + 0.15 * exp(-greatest(extract(epoch from (now() - c.first_seen_at)), 0) / 3600.0 / 24.0)
    + 0.20 * least(1.0,
          0.5 * (coalesce((c.flags->>'in_kev')::boolean, false))::int
        + 0.4 * (coalesce((c.flags->>'zero_day')::boolean, false))::int
        + 0.3 * (coalesce((c.flags->>'exploited')::boolean, false))::int
        + 0.3 * (coalesce((c.flags->>'brazil')::boolean, false))::int
        + 0.2 * (c.item_count >= 3)::int)
  )::numeric, 2)
$$;
revoke execute on function public.cluster_score(public.clusters) from public, anon;
