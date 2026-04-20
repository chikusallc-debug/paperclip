import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  contentWorkProducts,
  contentWorkProductVersions,
} from "@paperclipai/db";
import {
  evaluatePassCriteria,
  hasPassCriteria,
  isGatedTransition,
  type PassCriteriaResult,
} from "@paperclipai/shared";
import type {
  ContentWorkProduct,
  ContentWorkProductVersion,
  ContentWorkProductVersionSummary,
  ContentWorkProductWithLatest,
  CreateContentWorkProductInput,
  CreateContentWorkProductVersionInput,
  PublishContentWorkProductInput,
  UpdateContentWorkProductInput,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";

type ContentWorkProductRow = typeof contentWorkProducts.$inferSelect;
type ContentWorkProductVersionRow = typeof contentWorkProductVersions.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
  runId?: string | null;
}

export interface PassCriteriaEnforcementOptions {
  /**
   * Board override. When true, the gate is bypassed even if the work
   * product has unmet pass criteria. The route layer should only honor
   * this for board actors; agents must never bypass their own content
   * rules.
   */
  bypass?: boolean;
}

/**
 * 422 thrown when a status transition is blocked by failing pass
 * criteria. Extends HttpError so the existing error handler renders
 * it with `{ error, details: { code, failures, stats, targetStatus } }`.
 */
export class PassCriteriaError extends HttpError {
  readonly code = "pass_criteria_failed";
  readonly failures: PassCriteriaResult["failures"];
  readonly stats: PassCriteriaResult["stats"];
  readonly targetStatus: string;

  constructor(result: PassCriteriaResult, targetStatus: string) {
    const message = `Content work product cannot advance to "${targetStatus}": ${result.failures
      .map((f) => f.message)
      .join("; ")}`;
    super(422, message, {
      code: "pass_criteria_failed",
      targetStatus,
      failures: result.failures,
      stats: result.stats,
    });
    this.name = "PassCriteriaError";
    this.failures = result.failures;
    this.stats = result.stats;
    this.targetStatus = targetStatus;
  }
}

/**
 * Returns the pass-criteria rules stored on a work product row (under
 * `metadata.passCriteria`). Returns null when no criteria are defined,
 * which lets enforcement short-circuit without touching the body.
 */
function readPassCriteria(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as { passCriteria?: unknown }).passCriteria;
  if (!raw || typeof raw !== "object") return null;
  return raw as Record<string, unknown>;
}

function toWorkProduct(row: ContentWorkProductRow): ContentWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId ?? null,
    type: row.type,
    kind: row.kind,
    title: row.title,
    slug: row.slug ?? null,
    status: row.status,
    tags: (row.tags as string[] | null) ?? [],
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    latestVersionId: row.latestVersionId ?? null,
    latestVersionNumber: row.latestVersionNumber,
    publishedVersionId: row.publishedVersionId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: ContentWorkProductVersionRow): ContentWorkProductVersion {
  return {
    id: row.id,
    companyId: row.companyId,
    workProductId: row.workProductId,
    versionNumber: row.versionNumber,
    body: row.body,
    format: row.format,
    statusAtCreation: row.statusAtCreation,
    changeSummary: row.changeSummary ?? null,
    parentVersionId: row.parentVersionId ?? null,
    authoredByAgentId: row.authoredByAgentId ?? null,
    authoredByUserId: row.authoredByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt,
  };
}

function toVersionSummary(row: ContentWorkProductVersionRow): ContentWorkProductVersionSummary {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    changeSummary: row.changeSummary ?? null,
    statusAtCreation: row.statusAtCreation,
    format: row.format,
    authoredByAgentId: row.authoredByAgentId ?? null,
    authoredByUserId: row.authoredByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
  };
}

export interface ListContentWorkProductsFilters {
  projectId?: string | null;
  issueId?: string | null;
  type?: string;
  status?: string;
  kind?: string;
}

export function contentWorkProductService(db: Db) {
  async function getByIdWithinCompany(
    companyId: string,
    id: string,
  ): Promise<ContentWorkProductRow | null> {
    const rows = await db
      .select()
      .from(contentWorkProducts)
      .where(and(eq(contentWorkProducts.id, id), eq(contentWorkProducts.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function getVersionByNumber(
    workProductId: string,
    versionNumber: number,
  ): Promise<ContentWorkProductVersionRow | null> {
    const rows = await db
      .select()
      .from(contentWorkProductVersions)
      .where(
        and(
          eq(contentWorkProductVersions.workProductId, workProductId),
          eq(contentWorkProductVersions.versionNumber, versionNumber),
        ),
      );
    return rows[0] ?? null;
  }

  return {
    async list(
      companyId: string,
      filters: ListContentWorkProductsFilters = {},
    ): Promise<ContentWorkProduct[]> {
      const conditions = [eq(contentWorkProducts.companyId, companyId)];
      if (filters.projectId !== undefined) {
        conditions.push(
          filters.projectId === null
            ? sql`${contentWorkProducts.projectId} IS NULL`
            : eq(contentWorkProducts.projectId, filters.projectId),
        );
      }
      if (filters.issueId !== undefined) {
        conditions.push(
          filters.issueId === null
            ? sql`${contentWorkProducts.issueId} IS NULL`
            : eq(contentWorkProducts.issueId, filters.issueId),
        );
      }
      if (filters.type) conditions.push(eq(contentWorkProducts.type, filters.type));
      if (filters.status) conditions.push(eq(contentWorkProducts.status, filters.status));
      if (filters.kind) conditions.push(eq(contentWorkProducts.kind, filters.kind));

      const rows = await db
        .select()
        .from(contentWorkProducts)
        .where(and(...conditions))
        .orderBy(desc(contentWorkProducts.updatedAt));
      return rows.map(toWorkProduct);
    },

    async getById(companyId: string, id: string): Promise<ContentWorkProduct | null> {
      const row = await getByIdWithinCompany(companyId, id);
      return row ? toWorkProduct(row) : null;
    },

    /**
     * Most recently updated work product linked to a given issue
     * within a company. Used at wake-time so heartbeat hydration can
     * pull the WP's `metadata.contextPackIds` in addition to the
     * agent's own packs. Returns null when the issue has no work
     * product — the caller treats that as "nothing to merge".
     */
    async getLatestForIssue(
      companyId: string,
      issueId: string,
    ): Promise<ContentWorkProduct | null> {
      const rows = await db
        .select()
        .from(contentWorkProducts)
        .where(
          and(
            eq(contentWorkProducts.companyId, companyId),
            eq(contentWorkProducts.issueId, issueId),
          ),
        )
        .orderBy(desc(contentWorkProducts.updatedAt))
        .limit(1);
      return rows[0] ? toWorkProduct(rows[0]) : null;
    },

    /**
     * Extract `metadata.contextPackIds` from a work product's
     * metadata. Tolerant of missing / malformed metadata — returns
     * an empty array. Exposed so the heartbeat can pull the list
     * without duplicating the metadata-shape knowledge.
     */
    extractContextPackIdsFromMetadata(
      metadata: Record<string, unknown> | null | undefined,
    ): string[] {
      if (!metadata || typeof metadata !== "object") return [];
      const raw = (metadata as { contextPackIds?: unknown }).contextPackIds;
      if (!Array.isArray(raw)) return [];
      return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
    },

    async getWithLatest(
      companyId: string,
      id: string,
    ): Promise<ContentWorkProductWithLatest | null> {
      const row = await getByIdWithinCompany(companyId, id);
      if (!row) return null;
      let latest: ContentWorkProductVersion | null = null;
      if (row.latestVersionId) {
        const versionRows = await db
          .select()
          .from(contentWorkProductVersions)
          .where(eq(contentWorkProductVersions.id, row.latestVersionId));
        latest = versionRows[0] ? toVersion(versionRows[0]) : null;
      }
      return { ...toWorkProduct(row), latestVersion: latest };
    },

    async create(
      companyId: string,
      input: CreateContentWorkProductInput,
      actor: ActorContext,
    ): Promise<ContentWorkProductWithLatest> {
      const now = new Date();
      const kind = input.kind ?? "content";
      const status = input.status ?? "draft";
      const tags = input.tags ?? [];
      const metadata = input.metadata ?? {};

      const result = await db.transaction(async (tx) => {
        if (input.slug && input.projectId) {
          const existing = await tx
            .select({ id: contentWorkProducts.id })
            .from(contentWorkProducts)
            .where(
              and(
                eq(contentWorkProducts.companyId, companyId),
                eq(contentWorkProducts.projectId, input.projectId),
                eq(contentWorkProducts.slug, input.slug),
              ),
            );
          if (existing.length > 0) {
            throw conflict(
              `A content work product with slug "${input.slug}" already exists in this project`,
            );
          }
        }

        const [workProductRow] = await tx
          .insert(contentWorkProducts)
          .values({
            companyId,
            projectId: input.projectId ?? null,
            issueId: input.issueId ?? null,
            type: input.type,
            kind,
            title: input.title,
            slug: input.slug ?? null,
            status,
            tags,
            metadata,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!workProductRow) throw unprocessable("Failed to insert content work product");

        let latest: ContentWorkProductVersionRow | null = null;
        if (input.initialBody !== undefined) {
          const [versionRow] = await tx
            .insert(contentWorkProductVersions)
            .values({
              companyId,
              workProductId: workProductRow.id,
              versionNumber: 1,
              body: input.initialBody,
              format: input.initialFormat ?? "markdown",
              statusAtCreation: status,
              changeSummary: input.initialChangeSummary ?? null,
              parentVersionId: null,
              authoredByAgentId: actor.agentId,
              authoredByUserId: actor.userId,
              createdByRunId: actor.runId ?? null,
              metadata: {},
              createdAt: now,
            })
            .returning();
          if (!versionRow) throw unprocessable("Failed to insert initial version");
          latest = versionRow;

          await tx
            .update(contentWorkProducts)
            .set({
              latestVersionId: versionRow.id,
              latestVersionNumber: 1,
              updatedAt: now,
            })
            .where(eq(contentWorkProducts.id, workProductRow.id));

          workProductRow.latestVersionId = versionRow.id;
          workProductRow.latestVersionNumber = 1;
        }

        return { workProductRow, latest };
      });

      return {
        ...toWorkProduct(result.workProductRow),
        latestVersion: result.latest ? toVersion(result.latest) : null,
      };
    },

    async update(
      companyId: string,
      id: string,
      patch: UpdateContentWorkProductInput,
      actor: ActorContext,
      gate: PassCriteriaEnforcementOptions = {},
    ): Promise<ContentWorkProduct> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(contentWorkProducts)
          .where(
            and(eq(contentWorkProducts.id, id), eq(contentWorkProducts.companyId, companyId)),
          );
        const existing = rows[0];
        if (!existing) throw notFound("Content work product not found");

        // Pass-criteria gate: a PATCH can move status forward (e.g. a
        // tool marks a work product in_review after a long session).
        // Evaluate against the *latest* stored body + the incoming tag
        // set, since PATCH does not accept a new body.
        if (!gate.bypass && patch.status && patch.status !== existing.status) {
          const criteria = readPassCriteria(
            patch.metadata ?? (existing.metadata as Record<string, unknown> | null),
          );
          if (
            criteria &&
            hasPassCriteria(criteria) &&
            isGatedTransition(existing.status, patch.status)
          ) {
            // Load latest body (if any) — a work product with no
            // versions cannot clear any body-based criterion, so we
            // short-circuit to a useful failure.
            let body = "";
            if (existing.latestVersionId) {
              const versionRows = await tx
                .select({ body: contentWorkProductVersions.body })
                .from(contentWorkProductVersions)
                .where(eq(contentWorkProductVersions.id, existing.latestVersionId));
              body = versionRows[0]?.body ?? "";
            }
            const tags = patch.tags ?? ((existing.tags as string[] | null) ?? []);
            const result = evaluatePassCriteria({ body, tags, criteria });
            if (!result.passed) throw new PassCriteriaError(result, patch.status);
          }
        }

        const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
        const nextSlug = patch.slug === undefined ? existing.slug : patch.slug;
        if (nextSlug && nextProjectId) {
          if (nextSlug !== existing.slug || nextProjectId !== existing.projectId) {
            const conflictRows = await tx
              .select({ id: contentWorkProducts.id })
              .from(contentWorkProducts)
              .where(
                and(
                  eq(contentWorkProducts.companyId, companyId),
                  eq(contentWorkProducts.projectId, nextProjectId),
                  eq(contentWorkProducts.slug, nextSlug),
                ),
              );
            if (conflictRows.some((row) => row.id !== existing.id)) {
              throw conflict(
                `A content work product with slug "${nextSlug}" already exists in this project`,
              );
            }
          }
        }

        const [updated] = await tx
          .update(contentWorkProducts)
          .set({
            title: patch.title ?? existing.title,
            slug: patch.slug === undefined ? existing.slug : patch.slug,
            status: patch.status ?? existing.status,
            type: patch.type ?? existing.type,
            kind: patch.kind ?? existing.kind,
            tags: patch.tags ?? (existing.tags as string[] | null) ?? [],
            metadata: patch.metadata ?? (existing.metadata as Record<string, unknown> | null) ?? {},
            projectId: patch.projectId === undefined ? existing.projectId : patch.projectId,
            issueId: patch.issueId === undefined ? existing.issueId : patch.issueId,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(contentWorkProducts.id, id))
          .returning();
        if (!updated) throw unprocessable("Failed to update content work product");
        return toWorkProduct(updated);
      });
    },

    async remove(companyId: string, id: string): Promise<void> {
      const deleted = await db
        .delete(contentWorkProducts)
        .where(
          and(eq(contentWorkProducts.id, id), eq(contentWorkProducts.companyId, companyId)),
        )
        .returning({ id: contentWorkProducts.id });
      if (deleted.length === 0) throw notFound("Content work product not found");
    },

    async listVersions(
      companyId: string,
      workProductId: string,
    ): Promise<ContentWorkProductVersionSummary[]> {
      // Verify company scope first.
      const existing = await getByIdWithinCompany(companyId, workProductId);
      if (!existing) throw notFound("Content work product not found");

      const rows = await db
        .select()
        .from(contentWorkProductVersions)
        .where(eq(contentWorkProductVersions.workProductId, workProductId))
        .orderBy(desc(contentWorkProductVersions.versionNumber));
      return rows.map(toVersionSummary);
    },

    async getVersion(
      companyId: string,
      workProductId: string,
      versionNumber: number,
    ): Promise<ContentWorkProductVersion> {
      const existing = await getByIdWithinCompany(companyId, workProductId);
      if (!existing) throw notFound("Content work product not found");
      const row = await getVersionByNumber(workProductId, versionNumber);
      if (!row) throw notFound("Version not found");
      return toVersion(row);
    },

    async addVersion(
      companyId: string,
      workProductId: string,
      input: CreateContentWorkProductVersionInput,
      actor: ActorContext,
      gate: PassCriteriaEnforcementOptions = {},
    ): Promise<ContentWorkProductVersion> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(contentWorkProducts)
          .where(
            and(
              eq(contentWorkProducts.id, workProductId),
              eq(contentWorkProducts.companyId, companyId),
            ),
          );
        const wp = rows[0];
        if (!wp) throw notFound("Content work product not found");

        if (input.parentVersionId) {
          const parentRows = await tx
            .select({ id: contentWorkProductVersions.id })
            .from(contentWorkProductVersions)
            .where(
              and(
                eq(contentWorkProductVersions.id, input.parentVersionId),
                eq(contentWorkProductVersions.workProductId, workProductId),
              ),
            );
          if (parentRows.length === 0) {
            throw unprocessable("parentVersionId does not belong to this work product");
          }
        }

        const nextVersionNumber = wp.latestVersionNumber + 1;
        const now = new Date();
        const nextStatus = input.advanceStatusTo ?? wp.status;

        // Pass-criteria gate: when this version is advancing the work
        // product into a gated state, evaluate criteria against the
        // *incoming* body + current tags. Criteria live in the work
        // product's metadata.passCriteria (usually copied there from a
        // template at instantiate time). Board callers may bypass
        // explicitly; agents cannot.
        if (!gate.bypass) {
          const criteria = readPassCriteria(wp.metadata);
          if (
            criteria &&
            hasPassCriteria(criteria) &&
            isGatedTransition(wp.status, nextStatus)
          ) {
            const result = evaluatePassCriteria({
              body: input.body,
              tags: (wp.tags as string[] | null) ?? [],
              criteria,
            });
            if (!result.passed) throw new PassCriteriaError(result, nextStatus);
          }
        }

        const [versionRow] = await tx
          .insert(contentWorkProductVersions)
          .values({
            companyId,
            workProductId,
            versionNumber: nextVersionNumber,
            body: input.body,
            format: input.format ?? "markdown",
            statusAtCreation: nextStatus,
            changeSummary: input.changeSummary ?? null,
            parentVersionId: input.parentVersionId ?? wp.latestVersionId,
            authoredByAgentId: actor.agentId,
            authoredByUserId: actor.userId,
            createdByRunId: actor.runId ?? null,
            metadata: input.metadata ?? {},
            createdAt: now,
          })
          .returning();
        if (!versionRow) throw unprocessable("Failed to insert version");

        await tx
          .update(contentWorkProducts)
          .set({
            latestVersionId: versionRow.id,
            latestVersionNumber: nextVersionNumber,
            status: nextStatus,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            updatedAt: now,
          })
          .where(eq(contentWorkProducts.id, workProductId));

        return toVersion(versionRow);
      });
    },

    async publish(
      companyId: string,
      workProductId: string,
      input: PublishContentWorkProductInput,
      actor: ActorContext,
      gate: PassCriteriaEnforcementOptions = {},
    ): Promise<ContentWorkProduct> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(contentWorkProducts)
          .where(
            and(
              eq(contentWorkProducts.id, workProductId),
              eq(contentWorkProducts.companyId, companyId),
            ),
          );
        const wp = rows[0];
        if (!wp) throw notFound("Content work product not found");

        const targetVersionNumber = input.versionNumber ?? wp.latestVersionNumber;
        if (targetVersionNumber <= 0) {
          throw unprocessable("Cannot publish: no versions exist yet");
        }

        const versionRows = await tx
          .select()
          .from(contentWorkProductVersions)
          .where(
            and(
              eq(contentWorkProductVersions.workProductId, workProductId),
              eq(contentWorkProductVersions.versionNumber, targetVersionNumber),
            ),
          );
        const version = versionRows[0];
        if (!version) throw notFound("Version not found");

        // Pass-criteria gate: publish is the most consequential
        // transition (external egress follows). Evaluate against the
        // SELECTED version's body — an operator can publish an older
        // passing version even after drafting a later non-passing one.
        if (!gate.bypass) {
          const criteria = readPassCriteria(wp.metadata);
          if (
            criteria &&
            hasPassCriteria(criteria) &&
            isGatedTransition(wp.status, "published")
          ) {
            const result = evaluatePassCriteria({
              body: version.body,
              tags: (wp.tags as string[] | null) ?? [],
              criteria,
            });
            if (!result.passed) throw new PassCriteriaError(result, "published");
          }
        }

        const [updated] = await tx
          .update(contentWorkProducts)
          .set({
            publishedVersionId: version.id,
            status: "published",
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(contentWorkProducts.id, workProductId))
          .returning();
        if (!updated) throw unprocessable("Failed to publish content work product");
        return toWorkProduct(updated);
      });
    },

    /**
     * Evaluate the work product's pass-criteria (if any) against its
     * current latest body + tags. Does not mutate. Useful for:
     *
     *   - Agents: dry-run before attempting a status transition.
     *   - Operators: see at a glance which chapters are ready to
     *     advance and which are stuck.
     *
     * Returns `null` when the work product has no criteria configured —
     * callers treat "no criteria" as "unconstrained".
     */
    async evaluateCriteria(
      companyId: string,
      workProductId: string,
    ): Promise<{
      hasCriteria: boolean;
      criteria: Record<string, unknown>;
      result: PassCriteriaResult | null;
      evaluatedAgainstVersionNumber: number | null;
    }> {
      const row = await getByIdWithinCompany(companyId, workProductId);
      if (!row) throw notFound("Content work product not found");
      const criteria = readPassCriteria(row.metadata);
      if (!criteria || !hasPassCriteria(criteria)) {
        return {
          hasCriteria: false,
          criteria: criteria ?? {},
          result: null,
          evaluatedAgainstVersionNumber: null,
        };
      }
      let body = "";
      let versionNumber: number | null = null;
      if (row.latestVersionId) {
        const versionRows = await db
          .select({
            body: contentWorkProductVersions.body,
            versionNumber: contentWorkProductVersions.versionNumber,
          })
          .from(contentWorkProductVersions)
          .where(eq(contentWorkProductVersions.id, row.latestVersionId));
        body = versionRows[0]?.body ?? "";
        versionNumber = versionRows[0]?.versionNumber ?? null;
      }
      const result = evaluatePassCriteria({
        body,
        tags: (row.tags as string[] | null) ?? [],
        criteria,
      });
      return {
        hasCriteria: true,
        criteria,
        result,
        evaluatedAgainstVersionNumber: versionNumber,
      };
    },
  };
}

export type ContentWorkProductService = ReturnType<typeof contentWorkProductService>;
