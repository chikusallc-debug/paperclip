import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * knowledge_base_documents
 *
 * Durable reference material agents can read on every run: character
 * cards, location cards, timeline slices, style guides, brand-voice
 * documents, series bibles. Scope is (company_id, project_id) —
 * project_id NULL means the doc belongs to the whole company
 * (e.g. a brand-voice guide).
 *
 * Unlike content_work_products, knowledge base documents are not
 * versioned here. They are mutable by design — agents and operators
 * overwrite the body as lore evolves. Full-text history is kept in
 * the activity log and can be upgraded to row-versioning later if
 * continuity diffs become a hot path.
 */
export const knowledgeBaseDocuments = pgTable(
  "knowledge_base_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /**
     * Logical path inside the KB tree, e.g. "characters/elena-rostova.md",
     * "world/factions.md", "style-guide/prose-tone.md". Acts as the
     * stable identifier agents use to reference docs.
     */
    path: text("path").notNull(),
    title: text("title").notNull(),
    /**
     * Coarse taxonomy: "character", "location", "timeline",
     * "style_guide", "brand_voice", "series_bible", "custom".
     * Context pack rules can filter by kind.
     */
    kind: text("kind").notNull().default("custom"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * Typed structured metadata keyed by kind
     * (e.g. {arc: "villain", voiceSample: "..."} for characters).
     */
    frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().notNull().default({}),
    body: text("body").notNull(),
    format: text("format").notNull().default("markdown"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("knowledge_base_documents_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    companyKindIdx: index("knowledge_base_documents_company_kind_idx").on(
      table.companyId,
      table.kind,
    ),
    // Postgres treats NULLs as distinct, so we need two partial
    // unique indexes to enforce "one doc per path per scope".
    companyPathUq: uniqueIndex("knowledge_base_documents_company_path_uq")
      .on(table.companyId, table.path)
      .where(sql`${table.projectId} IS NULL`),
    companyProjectPathUq: uniqueIndex("knowledge_base_documents_company_project_path_uq")
      .on(table.companyId, table.projectId, table.path)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);

/**
 * context_packs
 *
 * Named bundles of KB documents. A pack is a *definition* of which docs
 * to pull together; resolving it runs the query and returns the doc
 * bundle. This is the single most important primitive for the novel
 * factory — deterministic, reproducible canon injection per chapter.
 *
 * rules schema (v1):
 *   includePaths?: string[]       -- exact paths to always include
 *   includeTagsAny?: string[]     -- include docs with ANY of these tags
 *   includeKinds?: string[]       -- include docs of these kinds
 *   maxDocs?: number              -- soft cap on total docs returned
 */
export const contextPacks = pgTable(
  "context_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("context_packs_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    companyNameUq: uniqueIndex("context_packs_company_name_uq")
      .on(table.companyId, table.name)
      .where(sql`${table.projectId} IS NULL`),
    companyProjectNameUq: uniqueIndex("context_packs_company_project_name_uq")
      .on(table.companyId, table.projectId, table.name)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);
