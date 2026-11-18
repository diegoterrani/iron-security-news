-- Coleta mais rápida e mais ampla (pedido do Terrani em 18/11/2026).
--
-- 1) Intervalos por urgência. Em produção já foi aplicado por SQL em 18/11; aqui fica registrado
--    para ambientes novos (idempotente). Fontes que publicam avisos críticos: 10 min; demais EN: 15; PT: 30.
-- 2) Fontes novas (PSIRTs de fabricantes, alertas, imprensa), DESATIVADAS até passarem no teste da VPS
--    (node dist/test-sources.js --all); feeds mudam de URL com frequência.

update sources s set fetch_interval_min = 10
  from brands b
 where b.id = s.brand_id and b.slug = 'iron'
   and s.name in ('CISA KEV', 'Microsoft MSRC', 'CISA Advisories', 'GitHub Advisories', 'BleepingComputer', 'The Hacker News', 'The Record');

insert into sources (brand_id, name, kind, url, lang, trust_weight, fetch_interval_min, enabled, config)
select b.id, s.name, 'rss'::source_kind, s.url, s.lang::lang, s.trust, s.mins, false, '{}'::jsonb
  from brands b
 cross join (values
   ('Fortinet PSIRT',          'https://www.fortiguard.com/rss/ir.xml',                                           'en', 1.00, 10),
   ('Cisco PSIRT',             'https://sec.cloudapps.cisco.com/security/center/psirtrss20/CiscoSecurityAdvisory.xml', 'en', 0.95, 15),
   ('Palo Alto Advisories',    'https://security.paloaltonetworks.com/rss.xml',                                   'en', 0.95, 15),
   ('SANS ISC',                'https://isc.sans.edu/rssfeed.xml',                                                'en', 0.90, 15),
   ('CERT-EU Advisories',      'https://www.cert.europa.eu/publications/security-advisories-rss',                 'en', 0.90, 15),
   ('Help Net Security',       'https://www.helpnetsecurity.com/feed/',                                           'en', 0.75, 15),
   ('CyberScoop',              'https://www.cyberscoop.com/feed/',                                                'en', 0.75, 15),
   ('Ars Technica Security',   'https://arstechnica.com/security/feed/',                                          'en', 0.75, 15),
   ('Wired Security',          'https://www.wired.com/feed/category/security/latest/rss',                         'en', 0.70, 30),
   ('CSO Online',              'https://www.csoonline.com/feed/',                                                 'en', 0.70, 30),
   ('Hackread',                'https://www.hackread.com/feed/',                                                  'en', 0.60, 15),
   ('DataBreaches.net',        'https://www.databreaches.net/feed/',                                              'en', 0.65, 30),
   ('CISO Brasil',             'https://ciso.com.br/feed/',                                                       'pt', 0.70, 30)
 ) as s(name, url, lang, trust, mins)
 where b.slug = 'iron'
on conflict (brand_id, url) do nothing;
