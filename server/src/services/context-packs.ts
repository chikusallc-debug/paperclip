import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { contextPacks } from "@paperclipai/db";
import type {
  ContextPack,
  ContextPackResolution,
  ContextPackRules,
} from "@paperclipai/shared";
import type {
  CreateContextPackInput,
  UpdateContextPackInput,
  ResolveContextPackInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  buildContextPackResolution,
  knowledgeBaseService,
} from "./knowledge-base.js";

type ContextPackRow = typeof contextPacks.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
}

function toPack(row: ContextPackRow): ContextPack {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    name: row.name,
    description: row.description ?? null,
    rules: (row.rules as ContextPackRules | null) ?? {},
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ListContextPacksFilters {
  /**
   * Undefined: all packs in the company. null: company-scope only.
   * string: project-scope only.
   */
  projectId?: string | null;
}

export function contextPackService(db: Db) {
  const kb = knowledgeBaseService(db);

  async function getRowInCompany(
    companyId: string,
    id: string,
  ): Promise<ContextPackRow | null> {
    const rows = await db
      .select()
      .from(contextPacks)
      .where(and(eq(contextPacks.id, id), eq(contextPacks.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function getByName(
    companyId: string,
    projectId: string | null,
    name: string,
  ): Promise<ContextPackRow | null> {
    const rows = await db
      .select()
      .from(contextPacks)
      .where(
        and(
          eq(contextPacks.companyId, companyId),
          projectId === null
            ? sql`${contextPacks.projectId} IS NULL`
            : eq(contextPacks.projectId, projectId),
          eq(contextPacks.name, name),
        ),
      );
    return rows[0] ?? null;
  }

  return {
    async list(companyId: string, filters: ListContextPacksFilters = {}): Promise<ContextPack[]> {
      const conditions = [eq(contextPacks.companyId, companyId)];
      if (filters.projectId !== undefined) {
        conditions.push(
          filters.projectId === null
            ? sql`${contextPacks.projectId} IS NULL`
            : eq(contextPacks.projectId, filters.projectId),
        );
      }
      const rows = await db
        .select()
        .from(contextPacks)
        .where(and(...conditions))
        .orderBy(desc(contextPacks.updatedAt));
      return rows.map(toPack);
    },

    async getById(companyId: string, id: string): Promise<ContextPack | null> {
      const row = await getRowInCompany(companyId, id);
      return row ? toPack(row) : null;
    },

    async getByName(
      companyId: string,
      projectId: string | null,
      name: string,
    ): Promise<ContextPack | null> {
      const row = await getByName(companyId, projectId, name);
      return row ? toPack(row) : null;
    },

    async create(
      companyId: string,
      input: CreateContextPackInput,
      actor: ActorContext,
    ): Promise<ContextPack> {
      const existing = await getByName(companyId, input.projectId ?? null, input.name);
      if (existing) {
        throw conflict(
          `A context pack named "${input.name}" already exists in this scope`,
        );
      }
      const [row] = await db
        .insert(contextPacks)
        .values({
          companyId,
          projectId: input.projectId ?? null,
          name: input.name,
          description: input.description ?? null,
          rules: (input.rules as Record<string, unknown> | undefined) ?? {},
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
        })
        .returning();
      if (!row) throw unprocessable("Failed to insert context pack");
      return toPack(row);
    },

    async update(
      companyId: string,
      id: string,
      patch: UpdateContextPackInput,
      actor: ActorContext,
    ): Promise<ContextPack> {
      const existing = await getRowInCompany(companyId, id);
      if (!existing) throw notFound("Context pack not found");

      const nextName = patch.name ?? existing.name;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      if (nextName !== existing.name || nextProjectId !== existing.projectId) {
        const collision = await getByName(companyId, nextProjectId ?? null, nextName);
        if (collision && collision.id !== existing.id) {
          throw conflict(
            `A context pack named "${nextName}" already exists in this scope`,
          );
        }
      }

      const [row] = await db
        .update(contextPacks)
        .set({
          name: nextName,
          description: patch.description === undefined ? existing.description : patch.description,
          rules: (patch.rules as Record<string, unknown> | undefined) ?? (existing.rules as Record<string, unknown> | null) ?? {},
          projectId: nextProjectId,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(contextPacks.id, id))
        .returning();
      if (!row) throw unprocessable("Failed to update context pack");
      return toPack(row);
    },

    async remove(companyId: string, id: string): Promise<void> {
      const deleted = await db
        .delete(contextPacks)
        .where(and(eq(contextPacks.id, id), eq(contextPacks.companyId, companyId)))
        .returning({ id: contextPacks.id });
      if (deleted.length === 0) throw notFound("Context pack not found");
    },

    /**
     * Resolve a saved pack by id, applying any ad-hoc override rules the
     * caller provided at resolve time (they are *merged*, not replaced,
     * with the pack's stored rules).
     */
    async resolve(
      companyId: string,
      id: string,
      input: ResolveContextPackInput = {},
    ): Promise<ContextPackResolution> {
      const existing = await getRowInCompany(companyId, id);
      if (!existing) throw notFound("Context pack not found");

      const base = (existing.rules as ContextPackRules | null) ?? {};
      const merged = kb.combineRules(base, input.overrideRules);
      const { docs, totalMatched, truncated } = await kb.resolveRules(
        companyId,
        existing.projectId ?? null,
        merged,
      );
      return buildContextPackResolution({
        packId: existing.id,
        name: existing.name,
        projectId: existing.projectId ?? null,
        rulesApplied: merged,
        docs,
        totalMatched,
        truncated,
      });
    },

    /**
     * Resolve ad-hoc rules without a saved pack. Handy for one-off
     * tooling / previewing context bundles before saving them.
     */
    async resolveAdHoc(
      companyId: string,
      projectId: string | null,
      rules: ContextPackRules,
    ): Promise<ContextPackResolution> {
      const { docs, totalMatched, truncated } = await kb.resolveRules(
        companyId,
        projectId,
        rules,
      );
      return buildContextPackResolution({
        packId: null,
        name: "ad-hoc",
        projectId,
        rulesApplied: rules,
        docs,
        totalMatched,
        truncated,
      });
    },
  };
}

export type ContextPackService = ReturnType<typeof contextPackService>;
