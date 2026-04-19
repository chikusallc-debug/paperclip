import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeBaseDocuments } from "@paperclipai/db";
import type {
  ContextPackRules,
  ContextPackResolution,
  KnowledgeBaseDocument,
  ResolvedContextPackDocument,
} from "@paperclipai/shared";
import type {
  CreateKnowledgeBaseDocumentInput,
  UpdateKnowledgeBaseDocumentInput,
  UpsertKnowledgeBaseDocumentInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type KnowledgeBaseDocumentRow = typeof knowledgeBaseDocuments.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
}

function toDocument(row: KnowledgeBaseDocumentRow): KnowledgeBaseDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    path: row.path,
    title: row.title,
    kind: row.kind,
    tags: (row.tags as string[] | null) ?? [],
    frontmatter: (row.frontmatter as Record<string, unknown> | null) ?? {},
    body: row.body,
    format: row.format,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ListKnowledgeBaseDocumentsFilters {
  /**
   * Undefined: no project filter (returns company-scoped + all projects).
   * null: only company-scoped docs.
   * string: only docs in that project.
   */
  projectId?: string | null;
  kind?: string;
  tag?: string;
  pathPrefix?: string;
}

function matchesAnyRule(
  doc: KnowledgeBaseDocumentRow,
  rules: ContextPackRules,
): boolean {
  const pathMatch = rules.includePaths?.includes(doc.path) ?? false;
  const tagMatch =
    rules.includeTagsAny && rules.includeTagsAny.length > 0
      ? rules.includeTagsAny.some((tag) =>
          ((doc.tags as string[] | null) ?? []).includes(tag),
        )
      : false;
  const kindMatch = rules.includeKinds?.includes(doc.kind) ?? false;
  return pathMatch || tagMatch || kindMatch;
}

function combineRules(
  base: ContextPackRules,
  override: ContextPackRules | undefined,
): ContextPackRules {
  if (!override) return base;
  return {
    includePaths: mergeUnique(base.includePaths, override.includePaths),
    includeTagsAny: mergeUnique(base.includeTagsAny, override.includeTagsAny),
    includeKinds: mergeUnique(base.includeKinds, override.includeKinds),
    maxDocs: override.maxDocs ?? base.maxDocs,
  };
}

function mergeUnique(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  const set = new Set<string>();
  for (const v of a ?? []) set.add(v);
  for (const v of b ?? []) set.add(v);
  return Array.from(set);
}

export function knowledgeBaseService(db: Db) {
  async function getRowByIdInCompany(
    companyId: string,
    id: string,
  ): Promise<KnowledgeBaseDocumentRow | null> {
    const rows = await db
      .select()
      .from(knowledgeBaseDocuments)
      .where(
        and(
          eq(knowledgeBaseDocuments.id, id),
          eq(knowledgeBaseDocuments.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  async function getRowByPathInScope(
    companyId: string,
    projectId: string | null,
    path: string,
  ): Promise<KnowledgeBaseDocumentRow | null> {
    const projectCondition =
      projectId === null
        ? sql`${knowledgeBaseDocuments.projectId} IS NULL`
        : eq(knowledgeBaseDocuments.projectId, projectId);
    const rows = await db
      .select()
      .from(knowledgeBaseDocuments)
      .where(
        and(
          eq(knowledgeBaseDocuments.companyId, companyId),
          projectCondition,
          eq(knowledgeBaseDocuments.path, path),
        ),
      );
    return rows[0] ?? null;
  }

  return {
    async list(
      companyId: string,
      filters: ListKnowledgeBaseDocumentsFilters = {},
    ): Promise<KnowledgeBaseDocument[]> {
      const conditions = [eq(knowledgeBaseDocuments.companyId, companyId)];
      if (filters.projectId !== undefined) {
        conditions.push(
          filters.projectId === null
            ? sql`${knowledgeBaseDocuments.projectId} IS NULL`
            : eq(knowledgeBaseDocuments.projectId, filters.projectId),
        );
      }
      if (filters.kind) conditions.push(eq(knowledgeBaseDocuments.kind, filters.kind));
      if (filters.pathPrefix) {
        const escaped = filters.pathPrefix.replace(/[%_]/g, (ch) => `\\${ch}`);
        conditions.push(sql`${knowledgeBaseDocuments.path} LIKE ${`${escaped}%`}`);
      }
      if (filters.tag) {
        // jsonb array containment: ?| or @>. Use @> for a single tag.
        conditions.push(
          sql`${knowledgeBaseDocuments.tags} @> ${JSON.stringify([filters.tag])}::jsonb`,
        );
      }

      const rows = await db
        .select()
        .from(knowledgeBaseDocuments)
        .where(and(...conditions))
        .orderBy(knowledgeBaseDocuments.path);
      return rows.map(toDocument);
    },

    async getById(companyId: string, id: string): Promise<KnowledgeBaseDocument | null> {
      const row = await getRowByIdInCompany(companyId, id);
      return row ? toDocument(row) : null;
    },

    async getByPath(
      companyId: string,
      projectId: string | null,
      path: string,
    ): Promise<KnowledgeBaseDocument | null> {
      const row = await getRowByPathInScope(companyId, projectId, path);
      return row ? toDocument(row) : null;
    },

    async create(
      companyId: string,
      input: CreateKnowledgeBaseDocumentInput,
      actor: ActorContext,
    ): Promise<KnowledgeBaseDocument> {
      const existing = await getRowByPathInScope(
        companyId,
        input.projectId ?? null,
        input.path,
      );
      if (existing) {
        throw conflict(
          `A knowledge base document already exists at "${input.path}" in this scope`,
        );
      }

      const [row] = await db
        .insert(knowledgeBaseDocuments)
        .values({
          companyId,
          projectId: input.projectId ?? null,
          path: input.path,
          title: input.title,
          kind: input.kind ?? "custom",
          tags: input.tags ?? [],
          frontmatter: input.frontmatter ?? {},
          body: input.body,
          format: input.format ?? "markdown",
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
        })
        .returning();
      if (!row) throw unprocessable("Failed to insert knowledge base document");
      return toDocument(row);
    },

    async update(
      companyId: string,
      id: string,
      patch: UpdateKnowledgeBaseDocumentInput,
      actor: ActorContext,
    ): Promise<KnowledgeBaseDocument> {
      const existing = await getRowByIdInCompany(companyId, id);
      if (!existing) throw notFound("Knowledge base document not found");

      const nextPath = patch.path ?? existing.path;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      if (nextPath !== existing.path || nextProjectId !== existing.projectId) {
        const collision = await getRowByPathInScope(companyId, nextProjectId ?? null, nextPath);
        if (collision && collision.id !== existing.id) {
          throw conflict(
            `A knowledge base document already exists at "${nextPath}" in this scope`,
          );
        }
      }

      const [row] = await db
        .update(knowledgeBaseDocuments)
        .set({
          title: patch.title ?? existing.title,
          path: nextPath,
          projectId: nextProjectId,
          kind: patch.kind ?? existing.kind,
          tags: patch.tags ?? (existing.tags as string[] | null) ?? [],
          frontmatter: patch.frontmatter ?? (existing.frontmatter as Record<string, unknown> | null) ?? {},
          body: patch.body ?? existing.body,
          format: patch.format ?? existing.format,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeBaseDocuments.id, id))
        .returning();
      if (!row) throw unprocessable("Failed to update knowledge base document");
      return toDocument(row);
    },

    async upsertByPath(
      companyId: string,
      input: UpsertKnowledgeBaseDocumentInput,
      actor: ActorContext,
    ): Promise<{ doc: KnowledgeBaseDocument; created: boolean }> {
      const existing = await getRowByPathInScope(companyId, input.projectId ?? null, input.path);
      if (!existing) {
        const created = await this.create(companyId, input, actor);
        return { doc: created, created: true };
      }
      const updated = await this.update(
        companyId,
        existing.id,
        {
          title: input.title,
          kind: input.kind,
          tags: input.tags,
          frontmatter: input.frontmatter,
          body: input.body,
          format: input.format,
        },
        actor,
      );
      return { doc: updated, created: false };
    },

    async remove(companyId: string, id: string): Promise<void> {
      const deleted = await db
        .delete(knowledgeBaseDocuments)
        .where(
          and(
            eq(knowledgeBaseDocuments.id, id),
            eq(knowledgeBaseDocuments.companyId, companyId),
          ),
        )
        .returning({ id: knowledgeBaseDocuments.id });
      if (deleted.length === 0) throw notFound("Knowledge base document not found");
    },

    async resolveRules(
      companyId: string,
      projectId: string | null,
      rules: ContextPackRules,
    ): Promise<{ docs: KnowledgeBaseDocument[]; totalMatched: number; truncated: boolean }> {
      const hasAnyRule =
        (rules.includePaths && rules.includePaths.length > 0) ||
        (rules.includeTagsAny && rules.includeTagsAny.length > 0) ||
        (rules.includeKinds && rules.includeKinds.length > 0);
      if (!hasAnyRule) {
        return { docs: [], totalMatched: 0, truncated: false };
      }

      const baseConditions = [eq(knowledgeBaseDocuments.companyId, companyId)];
      // Scope to project if provided. null means company-scope only.
      if (projectId === null) {
        baseConditions.push(sql`${knowledgeBaseDocuments.projectId} IS NULL`);
      } else {
        // include both project-scoped and company-scoped docs: project docs
        // override company defaults at the merge step below.
        baseConditions.push(
          sql`(${knowledgeBaseDocuments.projectId} = ${projectId} OR ${knowledgeBaseDocuments.projectId} IS NULL)`,
        );
      }

      // We fetch with a generous server-side filter (kinds and paths are
      // cheap; tag containment needs jsonb op; we union client-side to
      // keep the SQL simple).
      const orConditions: ReturnType<typeof sql>[] = [];
      if (rules.includePaths && rules.includePaths.length > 0) {
        orConditions.push(sql`${inArray(knowledgeBaseDocuments.path, rules.includePaths)}`);
      }
      if (rules.includeKinds && rules.includeKinds.length > 0) {
        orConditions.push(sql`${inArray(knowledgeBaseDocuments.kind, rules.includeKinds)}`);
      }
      if (rules.includeTagsAny && rules.includeTagsAny.length > 0) {
        // jsonb ?| operator: true if any of the right-hand array strings exist as top-level keys OR array elements.
        orConditions.push(
          sql`${knowledgeBaseDocuments.tags} ?| ${rules.includeTagsAny}::text[]`,
        );
      }

      const combined = orConditions.length === 1
        ? orConditions[0]
        : sql.join(orConditions, sql` OR `);
      const rows = await db
        .select()
        .from(knowledgeBaseDocuments)
        .where(and(...baseConditions, sql`(${combined})`))
        .orderBy(knowledgeBaseDocuments.path);

      // In case of overlapping project+company scope, prefer project-scoped doc
      // when two rows share the same path.
      const byPath = new Map<string, KnowledgeBaseDocumentRow>();
      for (const row of rows) {
        const existing = byPath.get(row.path);
        if (!existing || (row.projectId !== null && existing.projectId === null)) {
          byPath.set(row.path, row);
        }
      }
      // Post-filter: keep only rows that truly match at least one rule.
      const matched = Array.from(byPath.values()).filter((row) => matchesAnyRule(row, rules));
      const totalMatched = matched.length;
      const cap = rules.maxDocs;
      const capped = cap && cap > 0 ? matched.slice(0, cap) : matched;
      const docs = capped.map(toDocument);
      return { docs, totalMatched, truncated: cap ? totalMatched > cap : false };
    },

    combineRules,
  };
}

export function toResolvedContextPackDocument(doc: KnowledgeBaseDocument): ResolvedContextPackDocument {
  return {
    id: doc.id,
    path: doc.path,
    title: doc.title,
    kind: doc.kind,
    tags: doc.tags,
    frontmatter: doc.frontmatter,
    body: doc.body,
    format: doc.format,
    updatedAt: doc.updatedAt,
  };
}

export function buildContextPackResolution(input: {
  packId: string | null;
  name: string;
  projectId: string | null;
  rulesApplied: ContextPackRules;
  docs: KnowledgeBaseDocument[];
  totalMatched: number;
  truncated: boolean;
}): ContextPackResolution {
  return {
    packId: input.packId,
    name: input.name,
    projectId: input.projectId,
    rulesApplied: input.rulesApplied,
    documents: input.docs.map(toResolvedContextPackDocument),
    totalMatched: input.totalMatched,
    truncated: input.truncated,
    resolvedAt: new Date(),
  };
}

export type KnowledgeBaseService = ReturnType<typeof knowledgeBaseService>;
