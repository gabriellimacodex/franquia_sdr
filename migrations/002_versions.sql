CREATE TABLE sdr.drafts (
 tenant_id text NOT NULL, brand_id text NOT NULL, version_id text NOT NULL,
 snapshot jsonb NOT NULL, content_hash text NOT NULL,
 restored_from_version_id text, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,brand_id),
 FOREIGN KEY(tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,restored_from_version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);

CREATE TABLE sdr.validation_runs (
 id text PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY,
 tenant_id text NOT NULL, brand_id text NOT NULL, content_hash text NOT NULL,
 suite_type text NOT NULL CHECK(suite_type IN ('deterministic','conversation')),
 report jsonb NOT NULL, recorded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,brand_id,content_hash) REFERENCES sdr.versions(tenant_id,brand_id,content_hash)
);
CREATE INDEX validation_by_hash ON sdr.validation_runs(tenant_id,brand_id,content_hash,suite_type,sequence DESC);

CREATE TABLE sdr.publication_events (
 id text PRIMARY KEY, tenant_id text NOT NULL, brand_id text NOT NULL, version_id text NOT NULL,
 previous_version_id text, content_hash text NOT NULL, approved_by text NOT NULL,
 validation_run_ids jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,brand_id,version_id) REFERENCES sdr.versions(tenant_id,brand_id,id),
 FOREIGN KEY(tenant_id,brand_id,previous_version_id) REFERENCES sdr.versions(tenant_id,brand_id,id)
);

CREATE TRIGGER validation_immutable BEFORE UPDATE OR DELETE ON sdr.validation_runs
 FOR EACH ROW EXECUTE FUNCTION sdr.immutable_version();
CREATE TRIGGER publication_immutable BEFORE UPDATE OR DELETE ON sdr.publication_events
 FOR EACH ROW EXECUTE FUNCTION sdr.immutable_version();

DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['drafts','validation_runs','publication_events'] LOOP
  EXECUTE format('ALTER TABLE sdr.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE sdr.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY brand_isolation ON sdr.%I USING (tenant_id=current_setting(''sdr.tenant_id'',true) AND brand_id=current_setting(''sdr.brand_id'',true)) WITH CHECK (tenant_id=current_setting(''sdr.tenant_id'',true) AND brand_id=current_setting(''sdr.brand_id'',true))',table_name);
 END LOOP;
END $$;
REVOKE ALL ON sdr.drafts,sdr.validation_runs,sdr.publication_events FROM PUBLIC;
