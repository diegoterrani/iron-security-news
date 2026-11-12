-- Fontes: mais Brasil e ciclo de 1 h (pedido do Terrani em 12/11/2026).
--
-- 1) Todas as fontes buscam de hora em hora. Em produção isso já foi aplicado por SQL em 12/11;
--    aqui fica registrado para ambientes novos (idempotente).
-- 2) ransomware.live ganha coletor (só números agregados do país, sem nomes de vítimas) e passa a
--    usar o endpoint por país, que traz mais vítimas brasileiras do que o "recentvictims" global.
--    Continua DESATIVADA até passar no teste da VPS (node dist/test-sources.js --all).
-- 3) Novas fontes brasileiras, também DESATIVADAS até o teste (feeds mudam de URL com frequência).

update sources set fetch_interval_min = 60 where fetch_interval_min <> 60;

update sources s
   set url = 'https://api.ransomware.live/v2/countryvictims/BR', lang = 'pt',
       config = jsonb_build_object('country', 'BR', 'min_victims', 1)
  from brands b
 where b.id = s.brand_id and b.slug = 'iron' and s.kind = 'ransomware_live';

insert into sources (brand_id, name, kind, url, lang, trust_weight, fetch_interval_min, enabled, config)
select b.id, s.name, 'rss'::source_kind, s.url, 'pt'::lang, s.trust, 60, false, '{}'::jsonb
  from brands b
 cross join (values
   ('Security Report',            'https://www.securityreport.com.br/feed/',                        0.75),
   ('Canaltech Seguranca',        'https://canaltech.com.br/rss/seguranca/',                         0.65),
   ('Olhar Digital Seguranca',    'https://olhardigital.com.br/editorias/seguranca/feed/',           0.60),
   ('Convergencia Digital',       'https://www.convergenciadigital.com.br/feed/',                    0.70),
   ('ANPD Noticias',              'https://www.gov.br/anpd/pt-br/assuntos/noticias/RSS',             1.00)
 ) as s(name, url, trust)
 where b.slug = 'iron'
on conflict (brand_id, url) do nothing;
