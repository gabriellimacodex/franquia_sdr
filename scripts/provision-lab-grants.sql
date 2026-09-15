-- Additive laboratory upgrade grants. Never reset existing runtime/publisher privileges.
-- A fresh installation provisions its dedicated runtime role separately after migrations.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sdr_runtime') THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sdr_runtime' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
   RAISE EXCEPTION 'sdr_runtime must not have elevated role attributes; use a dedicated non-privileged runtime role';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='sdr_runtime') THEN
   RAISE EXCEPTION 'sdr_runtime must not inherit or switch to any other role';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='sdr' AND r.rolname='sdr_runtime') THEN
   RAISE EXCEPTION 'sdr_runtime must not own product tables; use a separate migration owner';
  END IF;
  GRANT SELECT,INSERT,UPDATE,DELETE ON sdr.lab_sessions TO sdr_runtime;
 END IF;
END $$;
