-- Apply on Supabase SQL editor (role with write on sdr.channels / testers / memberships).
-- sdr_runtime cannot run this. Keep CHANNEL enabled=false.
BEGIN;

INSERT INTO sdr.brands(tenant_id, id, name)
VALUES ('cognita-homologacao', 'sapore', 'Sapore Açaí')
ON CONFLICT DO NOTHING;

INSERT INTO sdr.channels(phone_number_id, tenant_id, brand_id, responsible_user_id, enabled)
VALUES (
  '1052683654599692',
  'cognita-homologacao',
  'sapore',
  '46a1a810-371d-4cc4-a26c-7af08b17bc93', -- Kapso user_id (Gábriel Limá)
  false
)
ON CONFLICT (phone_number_id) DO UPDATE
SET tenant_id = EXCLUDED.tenant_id,
    brand_id = EXCLUDED.brand_id,
    responsible_user_id = EXCLUDED.responsible_user_id;

INSERT INTO sdr.memberships(user_id, tenant_id, brand_id, role, active)
VALUES ('fbe8eabe-1907-412a-acb2-d14891d4f9a0', 'cognita-homologacao', 'sapore', 'admin', true)
ON CONFLICT DO NOTHING;

INSERT INTO sdr.testers(tenant_id, brand_id, contact_id, label) VALUES
  ('cognita-homologacao', 'sapore', '5511974410099', 'Testador autorizado 1'),
  ('cognita-homologacao', 'sapore', '5511957166850', 'Testador autorizado 2'),
  ('cognita-homologacao', 'sapore', '5511988566798', 'Testador autorizado 3')
ON CONFLICT DO NOTHING;

COMMIT;

SELECT phone_number_id,
       responsible_user_id IS NOT NULL AS has_responsible,
       enabled
FROM sdr.channels
WHERE phone_number_id = '1052683654599692';

SELECT count(*) AS testers
FROM sdr.testers
WHERE tenant_id = 'cognita-homologacao' AND brand_id = 'sapore';

SELECT role, count(*) AS n
FROM sdr.memberships
WHERE tenant_id = 'cognita-homologacao' AND brand_id = 'sapore' AND active
GROUP BY role
ORDER BY role;
