-- Seleção enxuta com foco no Brasil (pedido do Terrani em 24/11/2026).
--
-- Antes: seleção diária (1) + modo contínuo (até 8/dia) ⇒ 4 a 13 stories por dia, quase todas de alertas
-- estrangeiros (o peso de "Brasil" valia 6 pontos em 100). Agora:
--   * 2 stories por dia, uma por horário de publicação do blog (08:00 e 17:00), seleção contínua desligada;
--   * só entram pautas de severidade alta ou crítica e com impacto no Brasil >= min_br_impact;
--   * o impacto no Brasil (br_impact, 0–1, dado pela triagem triage@2) pesa 30% do score.

-- 1) Sinais novos no cluster
alter table clusters
  add column if not exists br_impact_max numeric(4,3) check (br_impact_max is null or br_impact_max between 0 and 1),
  add column if not exists severity_weight numeric(3,2) not null default 0 check (severity_weight between 0 and 1);

comment on column clusters.br_impact_max is 'Maior impacto no Brasil (0–1) dado pela triagem aos itens do cluster; null = triado antes do triage@2.';
comment on column clusters.severity_weight is 'Peso da maior severidade dos itens: critical 1, high 0,7, medium 0,4, low 0,15, info 0.';

create or replace function public.severity_weight(s severity) returns numeric
language sql immutable set search_path = public as $$
  select case s when 'critical' then 1.0 when 'high' then 0.7 when 'medium' then 0.4 when 'low' then 0.15 else 0 end
$$;
revoke execute on function public.severity_weight(severity) from public, anon;
grant execute on function public.severity_weight(severity) to ironnews_exec;

-- Backfill: severidade dos itens já triados; Brasil = 1 onde a triagem antiga marcou o fato como brasileiro.
update clusters c
   set severity_weight = coalesce((select max(severity_weight(r.severity)) from raw_items r
                                    where r.cluster_id = c.id and r.status = 'triaged' and r.severity is not null), 0),
       br_impact_max = case when coalesce((c.flags->>'brazil')::boolean, false) then 1 else c.br_impact_max end
 where c.last_seen_at > now() - interval '7 days';

-- 2) Score do cluster (0–100), versão com Brasil e severidade.
create or replace function public.cluster_score(c public.clusters) returns numeric
language sql stable set search_path = public as $$
  select round(100 * (
      0.30 * c.relevance_max
    + 0.30 * coalesce(c.br_impact_max, case when coalesce((c.flags->>'brazil')::boolean, false) then 1 else 0 end)
    + 0.15 * c.severity_weight
    + 0.10 * c.trust_max
    + 0.10 * least(1.0,
          0.5 * (coalesce((c.flags->>'in_kev')::boolean, false))::int
        + 0.4 * (coalesce((c.flags->>'zero_day')::boolean, false))::int
        + 0.3 * (coalesce((c.flags->>'exploited')::boolean, false))::int
        + 0.2 * (c.item_count >= 3)::int)
    + 0.05 * exp(-greatest(extract(epoch from (now() - c.first_seen_at)), 0) / 3600.0 / 24.0)
  )::numeric, 2)
$$;
revoke execute on function public.cluster_score(public.clusters) from public, anon;

-- 3) Configuração: 2 por dia em 2 horários, sem modo contínuo, corte de Brasil configurável.
alter table settings
  add column if not exists min_br_impact numeric(3,2) not null default 0.5 check (min_br_impact between 0 and 1);
comment on column settings.min_br_impact is 'Impacto mínimo no Brasil (0–1) para uma pauta entrar na seleção automática.';

update settings
   set posts_per_day = 2,
       max_posts_per_day = 2,
       realtime_enabled = false,
       min_score = 55,
       publish_times = jsonb_set(publish_times, '{blog}', '["08:00", "17:00"]'::jsonb)
 where brand_id = (select id from brands where slug = 'iron');
