CREATE TABLE `simulation_sessions` (
	`code` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
