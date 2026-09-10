-- This Worker is an on-demand proxy: build logs, build metadata and documentation
-- are fetched live per tool call, processed in memory and never persisted. The
-- log/docs cache tables from 0001 are removed. D1 now holds exactly two things:
-- CI/CD pause-and-restore coordination state, and reusable failure patterns.
DROP TABLE IF EXISTS build_log_cache;
DROP TABLE IF EXISTS docs_lookup_cache;
