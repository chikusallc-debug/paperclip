CREATE TABLE IF NOT EXISTS "content_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"kind" text DEFAULT 'content' NOT NULL,
	"title_template" text NOT NULL,
	"slug_template" text,
	"default_status" text DEFAULT 'draft' NOT NULL,
	"default_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_context_pack_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outline_body" text,
	"pass_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_templates_company_id_companies_id_fk') THEN
  ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_templates_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_templates_updated_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_templates_company_updated_idx" ON "content_templates" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_templates_company_type_idx" ON "content_templates" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_templates_company_name_uq" ON "content_templates" USING btree ("company_id","name");
