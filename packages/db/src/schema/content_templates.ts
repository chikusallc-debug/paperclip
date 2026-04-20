import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * content_templates
 *
 * Reusable blueprints for creating content work products. A template
 * captures the scaffolding an operator would otherwise re-enter for
 * every new novel chapter, course section, or landing page:
 *
 *   - target type / kind
 *   - title + slug patterns (supporting {{variable}} interpolation)
 *   - outline body (starter markdown inlined as the first version)
 *   - default status, tags, metadata
 *   - default context pack ids to associate with the instantiated
 *     work product (so auto-hydration carries the right canon)
 *   - pass_criteria jsonb — future M6 enforcement reads this; M4
 *     just stores and exposes it.
 *
 * Templates are company-scoped. `name` is the stable identifier used
 * by operators and portability manifests; it must be kebab-case and
 * unique per company.
 */
export const contentTemplates = pgTable(
  "content_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /**
     * Stable identifier like "novel-chapter" or "pdf-course-section".
     * Kebab-case; unique within a company.
     */
    name: text("name").notNull(),
    description: text("description"),
    /** Work-product type this template produces (e.g. "novel_chapter"). */
    type: text("type").notNull(),
    kind: text("kind").notNull().default("content"),
    /**
     * Mustache-style templates interpolated against
     * `{ variables }` on instantiate. Example:
     *   title_template: "Chapter {{n}}: {{title}}"
     *   slug_template:  "chapter-{{n}}"
     */
    titleTemplate: text("title_template").notNull(),
    slugTemplate: text("slug_template"),
    defaultStatus: text("default_status").notNull().default("draft"),
    defaultTags: jsonb("default_tags").$type<string[]>().notNull().default([]),
    defaultMetadata: jsonb("default_metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Default context packs to attach to the created work product's
     * metadata. Agents driving the work product can resolve these
     * explicitly; future per-work-product hydration will consume them
     * automatically.
     */
    defaultContextPackIds: jsonb("default_context_pack_ids").$type<string[]>().notNull().default([]),
    /**
     * Optional starter markdown inserted as the first version body.
     * Useful for chapter beat sheets, course-section scaffolds, etc.
     * Also supports {{variable}} interpolation.
     */
    outlineBody: text("outline_body"),
    /**
     * Freeform pass-criteria payload. Validated by factory profiles
     * but not enforced here; enforcement lands in M6 as a required
     * review gate before `draft → in_review`.
     */
    passCriteria: jsonb("pass_criteria").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("content_templates_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    companyTypeIdx: index("content_templates_company_type_idx").on(
      table.companyId,
      table.type,
    ),
    companyNameUq: uniqueIndex("content_templates_company_name_uq").on(
      table.companyId,
      table.name,
    ),
  }),
);
