-- Modo "quase real-time": seleção contínua de pautas urgentes, além da seleção diária.
-- Tudo desligado por padrão (realtime_enabled = false); o comportamento atual não muda até alguém ligar.

alter table settings
  add column if not exists realtime_enabled   boolean       not null default false,
  add column if not exists realtime_min_score numeric(5,2)  not null default 70
    check (realtime_min_score between 0 and 100),
  add column if not exists max_posts_per_day  int           not null default 8
    check (max_posts_per_day between 1 and 30),
  add column if not exists min_gap_min        int           not null default 15
    check (min_gap_min between 0 and 720);

comment on column settings.realtime_enabled   is 'Liga a seleção contínua (a cada minuto) de pautas com score >= realtime_min_score.';
comment on column settings.realtime_min_score is 'Score mínimo para uma pauta entrar fora da seleção diária.';
comment on column settings.max_posts_per_day  is 'Teto de stories criadas por dia local (seleção diária + contínua; rejeitadas não contam).';
comment on column settings.min_gap_min        is 'Intervalo mínimo, em minutos, entre duas stories criadas.';
