-- Ilustração de fundo gerada por IA (Cloudflare Workers AI, FLUX) para os criativos: uma por story,
-- compartilhada entre PT e EN (registrada com lang 'pt', channel 'blog', kind 'background').
alter table assets drop constraint assets_kind_check;
alter table assets add constraint assets_kind_check
  check (kind in ('cover', 'carousel_slide', 'card', 'video', 'thumbnail', 'background'));

alter table assets drop constraint assets_provider_check;
alter table assets add constraint assets_provider_check
  check (provider in ('og-render', 'heygen', 'workers-ai'));
