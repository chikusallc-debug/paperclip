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
import { companySecrets } from "./company_secrets.js";
import { contentWorkProducts, contentWorkProductVersions } from "./content_work_products.js";

/**
 * publishing_targets
 *
 * Fifth primitive of the Neuroxcel content factory: destinations an
 * operator can publish a content work product to (Gumroad via webhook,
 * your CMS, a Substack RSS ingester, a GitHub-backed static site, etc.).
 *
 * V1 supports only `type: "webhook"` — a generic authenticated HTTPS
 * POST that covers most CMS/publishing surfaces without adapter
 * code. Dedicated providers for GitHub (git push), R2/S3 (object
 * upload), and Substack (first-class API) land in follow-up
 * milestones.
 *
 * Credentials live in the existing `company_secrets` table and are
 * referenced here via `secret_id`. The provider code resolves the
 * secret at publish time — secrets never sit in the target row.
 */
export const publishingTargets = pgTable(
  "publishing_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable kebab-case identifier, unique per company. */
    name: text("name").notNull(),
    description: text("description"),
    /** Provider type. V1: "webhook". Future: "github", "r2", "substack". */
    type: text("type").notNull(),
    /**
     * Provider-specific config. For webhook:
     *   { url: string, method?: "POST"|"PUT", headers?: Record<string,string>,
     *     authHeader?: string, // header name to attach the resolved secret to (default "Authorization")
     *     authScheme?: string, // e.g. "Bearer " (default) — prepended to secret value
     *     hmacHeader?: string, // when set, HMAC-SHA256 of the body is added here
     *   }
     */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Optional reference to a company_secrets row holding the auth
     * credential (webhook token / API key / HMAC shared key).
     * ON DELETE SET NULL so rotating/deleting a secret doesn't cascade
     * into losing publish history.
     */
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    enabled: text("enabled").notNull().default("true"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("publishing_targets_company_name_uq").on(
      table.companyId,
      table.name,
    ),
    companyUpdatedIdx: index("publishing_targets_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
  }),
);

/**
 * publish_attempts
 *
 * Append-only audit log of every publish try. One row per
 * (work product version, target, attempt). Stores enough to
 * diagnose a failure (URL, status, first bytes of response) without
 * keeping the full response body forever.
 */
export const publishAttempts = pgTable(
  "publish_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    workProductId: uuid("work_product_id")
      .notNull()
      .references(() => contentWorkProducts.id, { onDelete: "cascade" }),
    workProductVersionId: uuid("work_product_version_id")
      .notNull()
      .references(() => contentWorkProductVersions.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => publishingTargets.id, { onDelete: "cascade" }),
    /** pending | success | failed */
    status: text("status").notNull().default("pending"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    /**
     * Compact snapshot of the outbound request: method, host, path,
     * byte size of the body, headers that were set (values redacted
     * for `authorization` and any `x-*-signature`). Never includes
     * the secret value.
     */
    requestSummary: jsonb("request_summary").$type<Record<string, unknown>>(),
    /**
     * Snapshot of the response: status, headers (redacted),
     * first 2 KB of body for diagnostics.
     */
    responseSummary: jsonb("response_summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyStartedIdx: index("publish_attempts_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
    targetStartedIdx: index("publish_attempts_target_started_idx").on(
      table.targetId,
      table.startedAt,
    ),
    workProductStartedIdx: index("publish_attempts_work_product_started_idx").on(
      table.workProductId,
      table.startedAt,
    ),
  }),
);
