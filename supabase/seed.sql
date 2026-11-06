-- Seed do IRON CYBER NEWS (dev/local). Em produção, ajustar o domínio antes de rodar.
insert into brands (slug, name, domain)
values ('iron', 'Iron Security', 'news.iron-security.com')
on conflict (slug) do nothing;

insert into settings (brand_id)
select id from brands where slug = 'iron'
on conflict (brand_id) do nothing;

-- Fontes iniciais (Anexo A do documento). Começam DESATIVADAS: validar cada uma com
-- POST /api/v1/sources/:id/test antes de ativar (feeds mudam de URL com frequência).
insert into sources (brand_id, name, kind, url, lang, trust_weight, fetch_interval_min, enabled, config)
select b.id, s.name, s.kind::source_kind, s.url, s.lang::lang, s.trust, s.interval_min, false, s.config::jsonb
from brands b
cross join (values
  ('CISA KEV',             'cisa_kev',        'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', 'en', 1.00,  60, '{}'),
  ('CISA Advisories',      'rss',             'https://www.cisa.gov/cybersecurity-advisories/all.xml',                          'en', 1.00,  60, '{}'),
  ('NVD criticas 24h',     'nvd',             'https://services.nvd.nist.gov/rest/json/cves/2.0',                                'en', 1.00, 120, '{"cvssV3Severity":"CRITICAL","windowHours":24}'),
  ('GitHub Advisories',    'github_advisory', 'https://api.github.com/advisories',                                               'en', 0.90, 120, '{"type":"reviewed","severity":"critical"}'),
  ('Microsoft MSRC',       'rss',             'https://api.msrc.microsoft.com/update-guide/rss',                                 'en', 1.00, 120, '{}'),
  ('BleepingComputer',     'rss',             'https://www.bleepingcomputer.com/feed/',                                          'en', 0.85,  30, '{}'),
  ('The Hacker News',      'rss',             'https://feeds.feedburner.com/TheHackersNews',                                     'en', 0.80,  30, '{}'),
  ('SecurityWeek',         'rss',             'https://www.securityweek.com/feed/',                                              'en', 0.80,  30, '{}'),
  ('The Record',           'rss',             'https://therecord.media/feed',                                                    'en', 0.85,  30, '{}'),
  ('Dark Reading',         'rss',             'https://www.darkreading.com/rss.xml',                                             'en', 0.75,  60, '{}'),
  ('Krebs on Security',    'rss',             'https://krebsonsecurity.com/feed/',                                               'en', 0.85, 120, '{}'),
  ('Google Project Zero',  'rss',             'https://googleprojectzero.blogspot.com/feeds/posts/default',                      'en', 0.95, 240, '{}'),
  ('Unit 42',              'rss',             'https://unit42.paloaltonetworks.com/feed/',                                       'en', 0.90, 120, '{}'),
  ('Cisco Talos',          'rss',             'https://blog.talosintelligence.com/rss/',                                         'en', 0.90, 120, '{}'),
  ('Kaspersky Securelist', 'rss',             'https://securelist.com/feed/',                                                    'en', 0.85, 120, '{}'),
  ('ESET WeLiveSecurity',  'rss',             'https://www.welivesecurity.com/en/rss/feed/',                                     'en', 0.85, 120, '{}'),
  ('ransomware.live',      'ransomware_live', 'https://api.ransomware.live/v2/recentvictims',                                    'en', 0.60,  60, '{"country":"BR"}'),
  ('CISO Advisor',         'rss',             'https://www.cisoadvisor.com.br/feed/',                                            'pt', 0.75,  30, '{}'),
  ('The Hack',             'rss',             'https://thehack.com.br/feed/',                                                    'pt', 0.65,  60, '{}'),
  ('Minuto da Seguranca',  'rss',             'https://minutodaseguranca.blog.br/feed/',                                         'pt', 0.60,  60, '{}'),
  ('CERT.br',              'rss',             'https://www.cert.br/rss/certbr-rss.xml',                                          'pt', 1.00, 240, '{}')
) as s(name, kind, url, lang, trust, interval_min, config)
where b.slug = 'iron'
on conflict (brand_id, url) do nothing;
