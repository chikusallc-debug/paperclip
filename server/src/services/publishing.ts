import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { publishAttempts, publishingTargets } from "@paperclipai/db";
import type {
  CreatePublishingTargetInput,
  PublishAttempt,
  PublishingTarget,
  PublishWorkProductInput,
  UpdatePublishingTargetInput,
} from "@paperclipai/shared";
import {
  githubTargetConfigSchema,
  webhookTargetConfigSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { contentWorkProductService } from "./content-work-products.js";
import { secretService } from "./secrets.js";
import { getPublishProvider } from "./publishing-providers.js";

/**
 * Validate a config payload against the provider type it's targeting.
 * Used at update time — create uses the shared schema's superRefine.
 */
function validateConfigForType(type: string, config: unknown): Record<string, unknown> {
  const schema = type === "github" ? githubTargetConfigSchema : webhookTargetConfigSchema;
  const result = schema.safeParse(config);
  if (!result.success) {
    throw unprocessable(`Invalid config for ${type} target: ${result.error.message}`);
  }
  return result.data as Record<string, unknown>;
}

type PublishingTargetRow = typeof publishingTargets.$inferSelect;
type PublishAttemptRow = typeof publishAttempts.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
}

function toTarget(row: PublishingTargetRow): PublishingTarget {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    config: (row.config as Record<string, unknown> | null) ?? {},
    secretId: row.secretId ?? null,
    enabled: row.enabled === "true",
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAttempt(row: PublishAttemptRow): PublishAttempt {
  return {
    id: row.id,
    companyId: row.companyId,
    workProductId: row.workProductId,
    workProductVersionId: row.workProductVersionId,
    targetId: row.targetId,
    status: row.status,
    httpStatus: row.httpStatus ?? null,
    durationMs: row.durationMs ?? null,
    requestSummary: (row.requestSummary as Record<string, unknown> | null) ?? null,
    responseSummary: (row.responseSummary as Record<string, unknown> | null) ?? null,
    errorMessage: row.errorMessage ?? null,
    requestedByAgentId: row.requestedByAgentId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
  };
}

export interface PublishOptions {
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export function publishingService(db: Db, opts: PublishOptions = {}) {
  const workProducts = contentWorkProductService(db);
  const secrets = secretService(db);

  async function getTargetRow(
    companyId: string,
    id: string,
  ): Promise<PublishingTargetRow | null> {
    const rows = await db
      .select()
      .from(publishingTargets)
      .where(and(eq(publishingTargets.id, id), eq(publishingTargets.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function getTargetByName(
    companyId: string,
    name: string,
  ): Promise<PublishingTargetRow | null> {
    const rows = await db
      .select()
      .from(publishingTargets)
      .where(and(eq(publishingTargets.companyId, companyId), eq(publishingTargets.name, name)));
    return rows[0] ?? null;
  }

  return {
    async listTargets(companyId: string): Promise<PublishingTarget[]> {
      const rows = await db
        .select()
        .from(publishingTargets)
        .where(eq(publishingTargets.companyId, companyId))
        .orderBy(desc(publishingTargets.updatedAt));
      return rows.map(toTarget);
    },

    async getTargetById(companyId: string, id: string): Promise<PublishingTarget | null> {
      const row = await getTargetRow(companyId, id);
      return row ? toTarget(row) : null;
    },

    async createTarget(
      companyId: string,
      input: CreatePublishingTargetInput,
      actor: ActorContext,
    ): Promise<PublishingTarget> {
      const collision = await getTargetByName(companyId, input.name);
      if (collision) {
        throw conflict(`A publishing target named "${input.name}" already exists`);
      }
      if (input.secretId) {
        // Verify the secret belongs to this company — prevents
        // agents/board from referencing a secret from another tenant.
        const secret = await secrets.getById(input.secretId);
        if (!secret || secret.companyId !== companyId) {
          throw unprocessable("secretId does not belong to this company");
        }
      }
      if (!getPublishProvider(input.type)) {
        throw unprocessable(`Unknown publishing provider type: ${input.type}`);
      }
      const [row] = await db
        .insert(publishingTargets)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          config: input.config as Record<string, unknown>,
          secretId: input.secretId ?? null,
          enabled: input.enabled === false ? "false" : "true",
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
        })
        .returning();
      if (!row) throw unprocessable("Failed to insert publishing target");
      return toTarget(row);
    },

    async updateTarget(
      companyId: string,
      id: string,
      patch: UpdatePublishingTargetInput,
      actor: ActorContext,
    ): Promise<PublishingTarget> {
      const existing = await getTargetRow(companyId, id);
      if (!existing) throw notFound("Publishing target not found");
      const nextName = patch.name ?? existing.name;
      if (nextName !== existing.name) {
        const collision = await getTargetByName(companyId, nextName);
        if (collision && collision.id !== existing.id) {
          throw conflict(`A publishing target named "${nextName}" already exists`);
        }
      }
      if (patch.secretId !== undefined && patch.secretId !== null) {
        const secret = await secrets.getById(patch.secretId);
        if (!secret || secret.companyId !== companyId) {
          throw unprocessable("secretId does not belong to this company");
        }
      }
      const [row] = await db
        .update(publishingTargets)
        .set({
          name: nextName,
          description: patch.description === undefined ? existing.description : patch.description,
          config: patch.config
            ? validateConfigForType(existing.type, patch.config)
            : (existing.config as Record<string, unknown>),
          secretId: patch.secretId === undefined ? existing.secretId : patch.secretId,
          enabled:
            patch.enabled === undefined
              ? existing.enabled
              : patch.enabled
                ? "true"
                : "false",
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(publishingTargets.id, id))
        .returning();
      if (!row) throw unprocessable("Failed to update publishing target");
      return toTarget(row);
    },

    async removeTarget(companyId: string, id: string): Promise<void> {
      const deleted = await db
        .delete(publishingTargets)
        .where(and(eq(publishingTargets.id, id), eq(publishingTargets.companyId, companyId)))
        .returning({ id: publishingTargets.id });
      if (deleted.length === 0) throw notFound("Publishing target not found");
    },

    async listAttemptsForWorkProduct(
      companyId: string,
      workProductId: string,
    ): Promise<PublishAttempt[]> {
      const rows = await db
        .select()
        .from(publishAttempts)
        .where(
          and(
            eq(publishAttempts.companyId, companyId),
            eq(publishAttempts.workProductId, workProductId),
          ),
        )
        .orderBy(desc(publishAttempts.startedAt));
      return rows.map(toAttempt);
    },

    /**
     * Publish a content work product to a named target. Resolves the
     * version (provided → published → latest), resolves the target's
     * auth secret, dispatches to the provider, writes a pending
     * attempt row first and updates it in place on completion.
     *
     * Authorization is caller-driven — this method trusts the caller
     * to have asserted company access on both the work product and
     * the target.
     */
    async publishWorkProduct(
      companyId: string,
      workProductId: string,
      targetId: string,
      input: PublishWorkProductInput,
      actor: ActorContext,
    ): Promise<PublishAttempt> {
      const wp = await workProducts.getWithLatest(companyId, workProductId);
      if (!wp) throw notFound("Content work product not found");
      if (wp.latestVersionNumber === 0) {
        throw unprocessable("Cannot publish: work product has no versions yet");
      }

      const desiredVersion =
        input.versionNumber ??
        // When unspecified, prefer the already-published pointer so a
        // re-publish of the same target gets the exact same bytes.
        (wp.publishedVersionId ? undefined : undefined);

      const versionNumberToFetch = input.versionNumber ?? wp.latestVersionNumber;
      const version = await workProducts.getVersion(companyId, workProductId, versionNumberToFetch);
      // `desiredVersion` kept for future semantic — currently unused.
      void desiredVersion;

      const target = await getTargetRow(companyId, targetId);
      if (!target) throw notFound("Publishing target not found");
      if (target.enabled !== "true") {
        throw unprocessable(`Publishing target "${target.name}" is disabled`);
      }
      const provider = getPublishProvider(target.type);
      if (!provider) {
        throw unprocessable(`Unknown publishing provider type: ${target.type}`);
      }

      // Resolve the auth secret if present. Never store it on the
      // attempt row; it only lives in the provider ctx for this call.
      let secretValue: string | null = null;
      if (target.secretId) {
        try {
          secretValue = await secrets.resolveSecretValue(
            companyId,
            target.secretId,
            "latest",
          );
        } catch {
          throw unprocessable(
            `Publishing target "${target.name}" references a missing/inaccessible secret`,
          );
        }
      }

      // Create the pending attempt row first so a crash mid-publish
      // still leaves a diagnosable record.
      const [pending] = await db
        .insert(publishAttempts)
        .values({
          companyId,
          workProductId,
          workProductVersionId: version.id,
          targetId,
          status: "pending",
          requestedByAgentId: actor.agentId,
          requestedByUserId: actor.userId,
        })
        .returning();
      if (!pending) throw unprocessable("Failed to create publish attempt row");

      const allowHttp = process.env.PAPERCLIP_PUBLISHING_ALLOW_HTTP === "true";
      const allowPrivateHosts = process.env.PAPERCLIP_PUBLISHING_ALLOW_PRIVATE === "true";

      const result = await provider.publish(
        target.config as Record<string, unknown>,
        {
          attemptId: pending.id,
          workProduct: {
            id: wp.id,
            title: wp.title,
            type: wp.type,
            kind: wp.kind,
            slug: wp.slug,
            tags: wp.tags,
            metadata: wp.metadata,
            projectId: wp.projectId,
          },
          version: {
            id: version.id,
            versionNumber: version.versionNumber,
            body: version.body,
            format: version.format,
            createdAt: version.createdAt.toISOString(),
          },
        },
        {
          secretValue,
          allowHttp,
          allowPrivateHosts,
          fetchImpl: opts.fetchImpl,
        },
      );

      const [updated] = await db
        .update(publishAttempts)
        .set({
          status: result.status,
          httpStatus: result.httpStatus,
          durationMs: result.durationMs,
          requestSummary: result.requestSummary,
          responseSummary: result.responseSummary,
          errorMessage: result.errorMessage,
          completedAt: new Date(),
        })
        .where(eq(publishAttempts.id, pending.id))
        .returning();
      if (!updated) throw unprocessable("Failed to update publish attempt row");
      return toAttempt(updated);
    },
  };
}

export type PublishingService = ReturnType<typeof publishingService>;
