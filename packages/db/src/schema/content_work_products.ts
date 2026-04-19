import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * content_work_products
 *
 * First-class content objects produced and refined by agents — novel
 * chapters, PDF course outlines, landing-page copy, style guides, series
 * bibles, etc. Distinct from issue_work_products, which tracks *external*
 * artifact references (PRs, deployments) linked to an issue. This table
 * stores actual content bodies with workflow state.
 */
export const contentWorkProducts = pgTable(
  "content_work_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    /**
     * Free-form content type. Factory profiles use domain-specific values
     * like "novel_chapter", "series_bible", "pdf_course_outline",
     * "landing_page", "style_guide". Keep as text for extensibility.
     */
    type: text("type").notNull(),
    /**
     * "content" for generated deliverables (chapters, landing pages) vs
     * "reference" for enduring inputs (style guides, series bibles).
     * Drives UI affordances and retention behaviour.
     */
    kind: text("kind").notNull().default("content"),
    title: text("title").notNull(),
    /**
     * Stable project-scoped identifier used by routines and agents (e.g.
     * "chapter-12", "course-outline"). Optional; when present, unique
     * within (company_id, project_id).
     */
    slug: text("slug"),
    /**
     * Workflow state: draft | in_review | final | published | archived.
     * Unknown values are accepted to allow domain profiles to extend the
     * state machine without a migration.
     */
    status: text("status").notNull().default("draft"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    latestVersionId: uuid("latest_version_id"),
    latestVersionNumber: integer("latest_version_number").notNull().default(0),
    publishedVersionId: uuid("published_version_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectUpdatedIdx: index("content_work_products_company_project_updated_idx").on(
      table.companyId,
      table.projectId,
      table.updatedAt,
    ),
    companyTypeIdx: index("content_work_products_company_type_idx").on(
      table.companyId,
      table.type,
    ),
    companyStatusIdx: index("content_work_products_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    // Slugs are unique per project so routines can target
    // "chapter-12" etc. deterministically.
    companyProjectSlugUq: uniqueIndex("content_work_products_company_project_slug_uq").on(
      table.companyId,
      table.projectId,
      table.slug,
    ),
  }),
);

/**
 * content_work_product_versions
 *
 * Immutable body snapshots. Every edit by an agent or operator creates a
 * new version. Lets agents hand off drafts safely (Writer → Continuity →
 * Editor), and gives operators a durable diff history for long-running
 * creative work.
 */
export const contentWorkProductVersions = pgTable(
  "content_work_product_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    workProductId: uuid("work_product_id")
      .notNull()
      .references(() => contentWorkProducts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    body: text("body").notNull(),
    format: text("format").notNull().default("markdown"),
    /** Work-product status at the moment this version was committed. */
    statusAtCreation: text("status_at_creation").notNull().default("draft"),
    changeSummary: text("change_summary"),
    /**
     * Optional pointer to the previous version this one was edited from.
     * Useful when an agent explicitly branches off an older revision.
     */
    parentVersionId: uuid("parent_version_id"),
    authoredByAgentId: uuid("authored_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authoredByUserId: text("authored_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workProductVersionUq: uniqueIndex("content_work_product_versions_work_product_version_uq").on(
      table.workProductId,
      table.versionNumber,
    ),
    companyCreatedIdx: index("content_work_product_versions_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
