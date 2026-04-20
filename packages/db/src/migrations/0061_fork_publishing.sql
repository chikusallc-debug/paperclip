CREATE TABLE IF NOT EXISTS "publishing_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"enabled" text DEFAULT 'true' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"work_product_id" uuid NOT NULL,
	"work_product_version_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"error_message" text,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publishing_targets_company_id_companies_id_fk') THEN
  ALTER TABLE "publishing_targets" ADD CONSTRAINT "publishing_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publishing_targets_secret_id_company_secrets_id_fk') THEN
  ALTER TABLE "publishing_targets" ADD CONSTRAINT "publishing_targets_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publishing_targets_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "publishing_targets" ADD CONSTRAINT "publishing_targets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publishing_targets_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "publishing_targets" ADD CONSTRAINT "publishing_targets_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_attempts_company_id_companies_id_fk') THEN
  ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_attempts_work_product_id_content_work_products_id_fk') THEN
  ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_work_product_id_content_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."content_work_products"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_attempts_work_product_version_id_content_work_product_versions_id_fk') THEN
  ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_work_product_version_id_content_work_product_versions_id_fk" FOREIGN KEY ("work_product_version_id") REFERENCES "public"."content_work_product_versions"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_attempts_target_id_publishing_targets_id_fk') THEN
  ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_target_id_publishing_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."publishing_targets"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_attempts_requested_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "publishing_targets_company_name_uq" ON "publishing_targets" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publishing_targets_company_updated_idx" ON "publishing_targets" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_attempts_company_started_idx" ON "publish_attempts" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_attempts_target_started_idx" ON "publish_attempts" USING btree ("target_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_attempts_work_product_started_idx" ON "publish_attempts" USING btree ("work_product_id","started_at");
