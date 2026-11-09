-- Ativa as fontes validadas com `node dist/test-sources.js --all` em 2026-11-09 (RN-SRC05).
-- Ficam desativadas:
--   CISO Advisor     HTTP 403 para clientes automatizados (bloqueio do site; não contornar)
--   ransomware.live  tipo `ransomware_live` ainda sem coletor
update sources s
   set enabled = true
  from brands b
 where b.id = s.brand_id and b.slug = 'iron'
   and s.name in (
     'CISA KEV', 'CISA Advisories', 'NVD criticas 24h', 'GitHub Advisories', 'Microsoft MSRC',
     'BleepingComputer', 'The Hacker News', 'SecurityWeek', 'The Record', 'Dark Reading',
     'Krebs on Security', 'Google Project Zero', 'Unit 42', 'Cisco Talos', 'Kaspersky Securelist',
     'ESET WeLiveSecurity', 'The Hack', 'Minuto da Seguranca', 'CERT.br'
   );
