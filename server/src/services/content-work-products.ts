import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  contentWorkProducts,
  contentWorkProductVersions,
} from "@paperclipai/db";
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
import { conflict, notFound, unprocessable } from "../errors.js";

type ContentWorkProductRow = typeof contentWorkProducts.$inferSelect;
type ContentWorkProductVersionRow = typeof contentWorkProductVersions.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
  runId?: string | null;
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
  };
}

export type ContentWorkProductService = ReturnType<typeof contentWorkProductService>;
