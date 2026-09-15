ALTER TABLE sdr.channels ADD COLUMN kind text NOT NULL DEFAULT 'whatsapp' CHECK(kind IN ('whatsapp','laboratory'));
ALTER TABLE sdr.memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE sdr.memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('tester','reviewer','admin'));
INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind)
 SELECT 'lab-'||md5(tenant_id||':'||id),tenant_id,id,'laboratory' FROM sdr.brands;
CREATE TABLE sdr.lab_sessions (
 tenant_id text NOT NULL, brand_id text NOT NULL, id text NOT NULL,
 owner_user_id text NOT NULL, request_id uuid NOT NULL, candidate_id text NOT NULL,
 label text NOT NULL, scenario text NOT NULL, version_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,brand_id,id), UNIQUE(tenant_id,brand_id,owner_user_id,request_id),
 FOREIGN KEY(tenant_id,brand_id,id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);
ALTER TABLE sdr.lab_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdr.lab_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY lab_sessions_scope ON sdr.lab_sessions USING (
 tenant_id=(SELECT current_setting('sdr.tenant_id',true)) AND brand_id=(SELECT current_setting('sdr.brand_id',true))
) WITH CHECK(tenant_id=(SELECT current_setting('sdr.tenant_id',true)) AND brand_id=(SELECT current_setting('sdr.brand_id',true)));
