CREATE SCHEMA IF NOT EXISTS sdr;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE sdr.brands (
 tenant_id text NOT NULL, id text NOT NULL, name text NOT NULL,
 PRIMARY KEY (tenant_id,id)
);
CREATE TABLE sdr.channels (
 phone_number_id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, responsible_user_id text,
 FOREIGN KEY (tenant_id,brand_id) REFERENCES sdr.brands(tenant_id,id)
);
CREATE TABLE sdr.testers (
 tenant_id text NOT NULL, brand_id text NOT NULL, contact_id text NOT NULL,
 label text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,brand_id,contact_id),
 FOREIGN KEY (tenant_id,brand_id) REFERENCES sdr.brands(tenant_id,id)
);
CREATE TABLE sdr.memberships (
 user_id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL,
 role text NOT NULL CHECK (role IN ('reviewer','admin')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(user_id,tenant_id,brand_id),
 FOREIGN KEY (tenant_id,brand_id) REFERENCES sdr.brands(tenant_id,id)
);
CREATE TABLE sdr.versions (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL,
 label text NOT NULL, snapshot jsonb NOT NULL, content_hash text NOT NULL,
 model text NOT NULL, test_status text NOT NULL DEFAULT 'untested',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,brand_id,id),
 UNIQUE(tenant_id,brand_id,content_hash),
 FOREIGN KEY (tenant_id,brand_id) REFERENCES sdr.brands(tenant_id,id)
);
CREATE TABLE sdr.active_versions (
 tenant_id text NOT NULL, brand_id text NOT NULL, version_id text NOT NULL,
 PRIMARY KEY(tenant_id,brand_id),
 FOREIGN KEY (tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);
CREATE FUNCTION sdr.immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Version snapshots are immutable'; END;
$$;
CREATE TRIGGER version_immutable BEFORE UPDATE OR DELETE ON sdr.versions
 FOR EACH ROW EXECUTE FUNCTION sdr.immutable_version();
CREATE TABLE sdr.candidates (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL,
 contact_id text NOT NULL, authorized_contact_id text NOT NULL, label text NOT NULL, lead_state jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,brand_id,id), UNIQUE(tenant_id,brand_id,contact_id),
 FOREIGN KEY (tenant_id,brand_id) REFERENCES sdr.brands(tenant_id,id)
);
CREATE TABLE sdr.conversations (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL,
 candidate_id text NOT NULL, phone_number_id text NOT NULL REFERENCES sdr.channels(phone_number_id),
 state text NOT NULL DEFAULT 'automatic' CHECK(state IN ('automatic','human','stopped')),
 epoch integer NOT NULL DEFAULT 0, execution_id text, control_fingerprint text,
 last_inbound_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,candidate_id) REFERENCES sdr.candidates(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.messages (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL,
 conversation_id text NOT NULL, candidate_id text NOT NULL,
 actor text NOT NULL CHECK(actor IN ('candidate','agent','human','system')),
 type text NOT NULL, text text NOT NULL DEFAULT '', media_id text, transcript_origin text,
 provider_timestamp timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,conversation_id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,brand_id,candidate_id) REFERENCES sdr.candidates(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.jobs (
 id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL,
 conversation_id text NOT NULL, candidate_id text NOT NULL, trigger_message_id text NOT NULL,
 context_version integer NOT NULL, epoch integer NOT NULL, version_id text NOT NULL,
 state text NOT NULL DEFAULT 'pending', result jsonb, error_code text,
 context jsonb, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now() + interval '2 seconds',
 deadline timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
 lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, completed_at timestamptz,
 UNIQUE(tenant_id,brand_id,conversation_id,trigger_message_id,epoch),
 FOREIGN KEY(tenant_id,brand_id,conversation_id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);
CREATE INDEX jobs_queue ON sdr.jobs(state,available_at);
CREATE TABLE sdr.facts (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL, candidate_id text NOT NULL,
 data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,candidate_id) REFERENCES sdr.candidates(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.relations (
 id text NOT NULL, tenant_id text NOT NULL, brand_id text NOT NULL, candidate_id text NOT NULL,
 data jsonb NOT NULL, PRIMARY KEY(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,candidate_id) REFERENCES sdr.candidates(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.events (
 id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL, conversation_id text NOT NULL,
 type text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,brand_id,conversation_id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.webhook_receipts (
 id text PRIMARY KEY, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sdr.deliveries (
 job_id text PRIMARY KEY REFERENCES sdr.jobs(id) ON DELETE CASCADE,
 tenant_id text NOT NULL, brand_id text NOT NULL, conversation_id text NOT NULL,
 state text NOT NULL DEFAULT 'dispatching', message_id text, text_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sdr.briefings (
 id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL, conversation_id text NOT NULL,
 version_id text, data jsonb NOT NULL, assignment_status text NOT NULL DEFAULT 'pending',
 model_status text NOT NULL DEFAULT 'pending',context_version integer, model_context jsonb,
 model_deadline timestamptz, usage jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,brand_id,conversation_id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE
);
CREATE TABLE sdr.knowledge_chunks (
 tenant_id text NOT NULL, brand_id text NOT NULL, version_id text NOT NULL, id text NOT NULL,
 title text NOT NULL, content text NOT NULL, approved boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT false, valid_from timestamptz NOT NULL, valid_until timestamptz,
 embedding vector(1536), metadata jsonb NOT NULL DEFAULT '{}',
 search tsvector GENERATED ALWAYS AS(to_tsvector('portuguese',content)) STORED,
 PRIMARY KEY(tenant_id,brand_id,version_id,id),
 FOREIGN KEY(tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);
CREATE INDEX knowledge_search ON sdr.knowledge_chunks USING gin(search);
CREATE TABLE sdr.evaluations (
 id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL,
 conversation_id text NOT NULL, job_id text NOT NULL REFERENCES sdr.jobs(id) ON DELETE CASCADE,
 user_id text NOT NULL, clarity integer CHECK(clarity BETWEEN 1 AND 5),
 relevance integer CHECK(relevance BETWEEN 1 AND 5), naturalness integer CHECK(naturalness BETWEEN 1 AND 5),
 briefing_utility integer CHECK(briefing_utility BETWEEN 1 AND 5), notes text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,brand_id,conversation_id) REFERENCES sdr.conversations(tenant_id,brand_id,id) ON DELETE CASCADE
);

-- This schema is not exposed through PostgREST. Backend transactions also scope every query.
-- Runtime role must be non-superuser and WITHOUT BYPASSRLS; migration credentials are separate.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['testers','versions','active_versions','candidates','conversations','messages','jobs','facts','relations','events','deliveries','briefings','knowledge_chunks','evaluations'] LOOP
   EXECUTE format('ALTER TABLE sdr.%I ENABLE ROW LEVEL SECURITY',tab);
   EXECUTE format('ALTER TABLE sdr.%I FORCE ROW LEVEL SECURITY',tab);
   EXECUTE format('CREATE POLICY brand_isolation ON sdr.%I USING (tenant_id=current_setting(''sdr.tenant_id'',true) AND brand_id=current_setting(''sdr.brand_id'',true)) WITH CHECK (tenant_id=current_setting(''sdr.tenant_id'',true) AND brand_id=current_setting(''sdr.brand_id'',true))',tab);
 END LOOP;
END $$;
REVOKE ALL ON SCHEMA sdr FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sdr FROM PUBLIC;
