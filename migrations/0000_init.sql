CREATE TABLE `build_pattern_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern_id` text NOT NULL,
	`event` text NOT NULL,
	`build_uuid` text,
	`actor` text,
	`notes` text,
	`evidence` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pattern_events` ON `build_pattern_events` (`pattern_id`,id DESC);--> statement-breakpoint
CREATE TABLE `build_patterns` (
	`pattern_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`explanation` text,
	`match_method` text NOT NULL,
	`match_expression` text NOT NULL,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_value` text,
	`scope_key` text DEFAULT '*' NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL,
	`root_cause` text,
	`resolution_steps` text,
	`lessons_learned` text,
	`verification_steps` text,
	`supporting_build_ids` text,
	`doc_urls` text,
	`version_constraints` text,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`superseded_by` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_verified_at` text,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` text,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_patterns_applicable` ON `build_patterns` (`scope_key`,`status`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_patterns_browse` ON `build_patterns` (`severity`,`confidence`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `cicd_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`action` text NOT NULL,
	`actor` text,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_worker` ON `cicd_audit` (`account_id`,`worker_name`,id DESC);--> statement-breakpoint
CREATE TABLE `cicd_leases` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`worker_tag` text NOT NULL,
	`owner` text NOT NULL,
	`reason` text,
	`idempotency_key` text,
	`acquired_at` text NOT NULL,
	`expires_at` text,
	`released_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_leases_active` ON `cicd_leases` (`account_id`,`worker_name`) WHERE released_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_leases_idem` ON `cicd_leases` (`account_id`,`worker_name`,`idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE `cicd_state` (
	`account_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`worker_tag` text NOT NULL,
	`phase` text DEFAULT 'active' NOT NULL,
	`saved_config` text,
	`saved_at` text,
	`expected_config` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`paused_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `worker_name`)
);
