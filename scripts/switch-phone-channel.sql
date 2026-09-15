-- Switch Sapore channel to Cognita-Nat. Keep enabled=false until ping works; app uses CHANNEL_ENABLED env separately.
BEGIN;

INSERT INTO sdr.brands(tenant_id, id, name)
VALUES ('cognita-homologacao', 'sapore', 'Sapore Açaí')
ON CONFLICT DO NOTHING;

-- disable old channel row if present
UPDATE sdr.channels
SET enabled = false
WHERE phone_number_id = '1052683654599692';

INSERT INTO sdr.channels(phone_number_id, tenant_id, brand_id, responsible_user_id, enabled)
VALUES (
  '1093705843816293',
  'cognita-homologacao',
  'sapore',
  '46a1a810-371d-4cc4-a26c-7af08b17bc93',
  false
)
ON CONFLICT (phone_number_id) DO UPDATE
SET tenant_id = EXCLUDED.tenant_id,
    brand_id = EXCLUDED.brand_id,
    responsible_user_id = EXCLUDED.responsible_user_id;

COMMIT;

SELECT phone_number_id, responsible_user_id IS NOT NULL AS has_responsible, enabled
FROM sdr.channels
WHERE phone_number_id IN ('1052683654599692','1093705843816293')
ORDER BY phone_number_id;
