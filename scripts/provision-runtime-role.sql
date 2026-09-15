-- Run deliberately as the migration administrator AFTER migrations/001_sdr.sql.
-- This creates privileges only. It never changes candidates, messages, source versions or brand configuration.
-- Configure the password through the database secret manager or psql's \password sdr_runtime.
-- Never paste a password into this script or use this role as the migration owner.
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sdr_runtime') THEN
    CREATE ROLE sdr_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sdr_runtime' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'sdr_runtime must not have elevated role attributes; use a dedicated non-privileged runtime role';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='sdr_runtime') THEN
    RAISE EXCEPTION 'sdr_runtime must not inherit or switch to any other role';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='sdr' AND r.rolname='sdr_runtime') THEN
    RAISE EXCEPTION 'sdr_runtime must not own product tables; use a separate migration owner';
  END IF;
END;
$$;
-- statement-breakpoint
-- Managed CREATEROLE administrators cannot reset every privileged attribute, even to false.
-- Existing elevated roles are rejected above; only normalize ordinary login/inheritance settings.
ALTER ROLE sdr_runtime LOGIN NOINHERIT;
-- statement-breakpoint
ALTER ROLE sdr_runtime SET row_security=on;
-- statement-breakpoint
REVOKE ALL ON SCHEMA sdr FROM sdr_runtime;
-- statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA sdr FROM sdr_runtime;
-- statement-breakpoint
GRANT USAGE ON SCHEMA sdr TO sdr_runtime;
-- statement-breakpoint
GRANT SELECT ON sdr.brands,sdr.channels,sdr.memberships,sdr.testers,sdr.versions,sdr.active_versions,sdr.knowledge_chunks TO sdr_runtime;
-- statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON sdr.candidates,sdr.conversations,sdr.messages,sdr.jobs,sdr.facts,sdr.relations,sdr.events,sdr.deliveries,sdr.briefings,sdr.evaluations,sdr.webhook_receipts TO sdr_runtime;
-- No CREATE, TRUNCATE, table ownership, policy changes, configuration writes or version deletion.
-- Laboratory migration is optional while upgrading an existing installation.
-- statement-breakpoint
DO $$ BEGIN
 IF to_regclass('sdr.lab_sessions') IS NOT NULL THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON sdr.lab_sessions TO sdr_runtime;
 END IF;
END $$;
-- No grant on the n8n database. This script applies only to the product's sdr schema.
-- For a managed pooler, configure its supported runtime-role username independently.
