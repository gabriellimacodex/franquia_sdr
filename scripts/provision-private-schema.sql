-- Run after each SDR migration, inside its transaction, as the object creator (postgres on Supabase).
-- The sdr schema must belong exclusively to this product. No public schema/defaults are changed.
-- Schema-scoped defaults do not override global defaults; keep sdr outside PostgREST's exposed schemas.
REVOKE ALL ON SCHEMA sdr FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sdr FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sdr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sdr FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA sdr REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA sdr REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA sdr REVOKE ALL ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE api_role text; object_type text;
BEGIN
 FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA sdr FROM %I',api_role);
  FOREACH object_type IN ARRAY ARRAY['TABLES','SEQUENCES','FUNCTIONS'] LOOP
   EXECUTE format('REVOKE ALL ON ALL %s IN SCHEMA sdr FROM %I',object_type,api_role);
   EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA sdr REVOKE ALL ON %s FROM %I',object_type,api_role);
  END LOOP;
 END LOOP;
END;
$$;
