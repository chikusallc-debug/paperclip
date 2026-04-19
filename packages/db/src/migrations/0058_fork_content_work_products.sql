CREATE TABLE IF NOT EXISTS "content_work_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"type" text NOT NULL,
	"kind" text DEFAULT 'content' NOT NULL,
	"title" text NOT NULL,
	"slug" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest_version_id" uuid,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"published_version_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_work_product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"work_product_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"body" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"status_at_creation" text DEFAULT 'draft' NOT NULL,
	"change_summary" text,
	"parent_version_id" uuid,
	"authored_by_agent_id" uuid,
	"authored_by_user_id" text,
	"created_by_run_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_products_company_id_companies_id_fk') THEN
  ALTER TABLE "content_work_products" ADD CONSTRAINT "content_work_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_products_project_id_projects_id_fk') THEN
  ALTER TABLE "content_work_products" ADD CONSTRAINT "content_work_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_products_issue_id_issues_id_fk') THEN
  ALTER TABLE "content_work_products" ADD CONSTRAINT "content_work_products_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_products_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "content_work_products" ADD CONSTRAINT "content_work_products_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_products_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "content_work_products" ADD CONSTRAINT "content_work_products_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_product_versions_company_id_companies_id_fk') THEN
  ALTER TABLE "content_work_product_versions" ADD CONSTRAINT "content_work_product_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_product_versions_work_product_id_content_work_products_id_fk') THEN
  ALTER TABLE "content_work_product_versions" ADD CONSTRAINT "content_work_product_versions_work_product_id_content_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."content_work_products"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_product_versions_authored_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "content_work_product_versions" ADD CONSTRAINT "content_work_product_versions_authored_by_agent_id_agents_id_fk" FOREIGN KEY ("authored_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_work_product_versions_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "content_work_product_versions" ADD CONSTRAINT "content_work_product_versions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_work_products_company_project_updated_idx" ON "content_work_products" USING btree ("company_id","project_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_work_products_company_type_idx" ON "content_work_products" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_work_products_company_status_idx" ON "content_work_products" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_work_products_company_project_slug_uq" ON "content_work_products" USING btree ("company_id","project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_work_product_versions_work_product_version_uq" ON "content_work_product_versions" USING btree ("work_product_id","version_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_work_product_versions_company_created_idx" ON "content_work_product_versions" USING btree ("company_id","created_at");
