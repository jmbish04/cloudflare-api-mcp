DROP INDEX `idx_patterns_browse`;--> statement-breakpoint
CREATE INDEX `idx_patterns_browse` ON `build_patterns` (`severity`,"confidence" desc) WHERE deleted_at IS NULL;