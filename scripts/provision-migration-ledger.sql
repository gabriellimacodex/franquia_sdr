-- Run as the migration owner inside a transaction, before applying migrations.
-- Only this product's ledger is changed; other public tables/default grants are untouched.
CREATE TABLE IF NOT EXISTS public.sapore_sdr_migrations (
 version text PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT now()
);

-- The migration owner retains access. No API policy is needed for this private ledger.
ALTER TABLE public.sapore_sdr_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sapore_sdr_migrations FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
 FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.sapore_sdr_migrations FROM %I',api_role);
 END LOOP;
END;
$$;
