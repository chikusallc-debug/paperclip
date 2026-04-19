CREATE TABLE IF NOT EXISTS "knowledge_base_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_base_documents_company_id_companies_id_fk') THEN
  ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_base_documents_project_id_projects_id_fk') THEN
  ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_base_documents_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_base_documents_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_packs_company_id_companies_id_fk') THEN
  ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_packs_project_id_projects_id_fk') THEN
  ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_packs_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_packs_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_documents_company_updated_idx" ON "knowledge_base_documents" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_documents_company_kind_idx" ON "knowledge_base_documents" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_base_documents_company_path_uq" ON "knowledge_base_documents" USING btree ("company_id","path") WHERE "project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_base_documents_company_project_path_uq" ON "knowledge_base_documents" USING btree ("company_id","project_id","path") WHERE "project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_packs_company_updated_idx" ON "context_packs" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_packs_company_name_uq" ON "context_packs" USING btree ("company_id","name") WHERE "project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_packs_company_project_name_uq" ON "context_packs" USING btree ("company_id","project_id","name") WHERE "project_id" IS NOT NULL;
