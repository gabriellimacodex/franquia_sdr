-- After 002_versions and provision-runtime-role.sql, deliberately grant the authenticated
-- admin configuration endpoints. HTTP handlers and Versioning both check active membership.
-- No API endpoint can insert validation reports; trusted recorder CLI uses migration credentials.
GRANT SELECT,INSERT ON sdr.versions TO sdr_runtime;
GRANT SELECT,INSERT,UPDATE ON sdr.drafts,sdr.active_versions TO sdr_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON sdr.knowledge_chunks TO sdr_runtime;
GRANT SELECT ON sdr.validation_runs TO sdr_runtime;
GRANT SELECT,INSERT ON sdr.publication_events TO sdr_runtime;
