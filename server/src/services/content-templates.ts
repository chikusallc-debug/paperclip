import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { contentTemplates } from "@paperclipai/db";
import type {
  ContentTemplate,
  ContentWorkProductWithLatest,
  CreateContentTemplateInput,
  InstantiateContentTemplateInput,
  UpdateContentTemplateInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { contentWorkProductService } from "./content-work-products.js";

type ContentTemplateRow = typeof contentTemplates.$inferSelect;

interface ActorContext {
  userId: string | null;
  agentId: string | null;
  runId?: string | null;
}

function toTemplate(row: ContentTemplateRow): ContentTemplate {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    kind: row.kind,
    titleTemplate: row.titleTemplate,
    slugTemplate: row.slugTemplate ?? null,
    defaultStatus: row.defaultStatus,
    defaultTags: (row.defaultTags as string[] | null) ?? [],
    defaultMetadata: (row.defaultMetadata as Record<string, unknown> | null) ?? {},
    defaultContextPackIds: (row.defaultContextPackIds as string[] | null) ?? [],
    outlineBody: row.outlineBody ?? null,
    passCriteria: (row.passCriteria as Record<string, unknown> | null) ?? {},
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Simple {{variable}} interpolation with a small, predictable set of
 * rules:
 *
 *   - only top-level identifiers: {{name}}, {{n}}, {{title}}
 *   - missing variables render as empty string (so templates are
 *     forgiving for partially-filled factories)
 *   - values are string-coerced; numbers (e.g. chapter 12) render
 *     naturally
 *
 * No Mustache/Handlebars dependency; this is intentional — factory
 * templates should stay auditable, not Turing-complete.
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string | number>,
): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name) => {
    const raw = variables[name];
    if (raw === undefined || raw === null) return "";
    return String(raw);
  });
}

export interface ListContentTemplatesFilters {
  type?: string;
  kind?: string;
}

export function contentTemplateService(db: Db) {
  const workProducts = contentWorkProductService(db);

  async function getRow(
    companyId: string,
    id: string,
  ): Promise<ContentTemplateRow | null> {
    const rows = await db
      .select()
      .from(contentTemplates)
      .where(and(eq(contentTemplates.id, id), eq(contentTemplates.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function getByName(
    companyId: string,
    name: string,
  ): Promise<ContentTemplateRow | null> {
    const rows = await db
      .select()
      .from(contentTemplates)
      .where(and(eq(contentTemplates.companyId, companyId), eq(contentTemplates.name, name)));
    return rows[0] ?? null;
  }

  return {
    async list(
      companyId: string,
      filters: ListContentTemplatesFilters = {},
    ): Promise<ContentTemplate[]> {
      const conditions = [eq(contentTemplates.companyId, companyId)];
      if (filters.type) conditions.push(eq(contentTemplates.type, filters.type));
      if (filters.kind) conditions.push(eq(contentTemplates.kind, filters.kind));
      const rows = await db
        .select()
        .from(contentTemplates)
        .where(and(...conditions))
        .orderBy(desc(contentTemplates.updatedAt));
      return rows.map(toTemplate);
    },

    async getById(companyId: string, id: string): Promise<ContentTemplate | null> {
      const row = await getRow(companyId, id);
      return row ? toTemplate(row) : null;
    },

    async getByName(companyId: string, name: string): Promise<ContentTemplate | null> {
      const row = await getByName(companyId, name);
      return row ? toTemplate(row) : null;
    },

    async create(
      companyId: string,
      input: CreateContentTemplateInput,
      actor: ActorContext,
    ): Promise<ContentTemplate> {
      const collision = await getByName(companyId, input.name);
      if (collision) {
        throw conflict(`A content template named "${input.name}" already exists in this company`);
      }
      const [row] = await db
        .insert(contentTemplates)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          kind: input.kind ?? "content",
          titleTemplate: input.titleTemplate,
          slugTemplate: input.slugTemplate ?? null,
          defaultStatus: input.defaultStatus ?? "draft",
          defaultTags: input.defaultTags ?? [],
          defaultMetadata: input.defaultMetadata ?? {},
          defaultContextPackIds: input.defaultContextPackIds ?? [],
          outlineBody: input.outlineBody ?? null,
          passCriteria: input.passCriteria ?? {},
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
        })
        .returning();
      if (!row) throw unprocessable("Failed to insert content template");
      return toTemplate(row);
    },

    async update(
      companyId: string,
      id: string,
      patch: UpdateContentTemplateInput,
      actor: ActorContext,
    ): Promise<ContentTemplate> {
      const existing = await getRow(companyId, id);
      if (!existing) throw notFound("Content template not found");
      const nextName = patch.name ?? existing.name;
      if (nextName !== existing.name) {
        const collision = await getByName(companyId, nextName);
        if (collision && collision.id !== existing.id) {
          throw conflict(`A content template named "${nextName}" already exists in this company`);
        }
      }
      const [row] = await db
        .update(contentTemplates)
        .set({
          name: nextName,
          description: patch.description === undefined ? existing.description : patch.description,
          type: patch.type ?? existing.type,
          kind: patch.kind ?? existing.kind,
          titleTemplate: patch.titleTemplate ?? existing.titleTemplate,
          slugTemplate: patch.slugTemplate === undefined ? existing.slugTemplate : patch.slugTemplate,
          defaultStatus: patch.defaultStatus ?? existing.defaultStatus,
          defaultTags: patch.defaultTags ?? (existing.defaultTags as string[] | null) ?? [],
          defaultMetadata:
            patch.defaultMetadata ?? (existing.defaultMetadata as Record<string, unknown> | null) ?? {},
          defaultContextPackIds:
            patch.defaultContextPackIds ?? (existing.defaultContextPackIds as string[] | null) ?? [],
          outlineBody: patch.outlineBody === undefined ? existing.outlineBody : patch.outlineBody,
          passCriteria:
            patch.passCriteria ?? (existing.passCriteria as Record<string, unknown> | null) ?? {},
          updatedByAgentId: actor.agentId,
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(contentTemplates.id, id))
        .returning();
      if (!row) throw unprocessable("Failed to update content template");
      return toTemplate(row);
    },

    async remove(companyId: string, id: string): Promise<void> {
      const deleted = await db
        .delete(contentTemplates)
        .where(and(eq(contentTemplates.id, id), eq(contentTemplates.companyId, companyId)))
        .returning({ id: contentTemplates.id });
      if (deleted.length === 0) throw notFound("Content template not found");
    },

    /**
     * Turn a template into a fresh content work product. Interpolates
     * `titleTemplate`, `slugTemplate`, and `outlineBody` with the
     * caller-supplied `variables`; applies any `overrides` on top
     * (e.g. attach to an issue, add extra context packs for this
     * specific instance).
     *
     * The resulting work product records the template's
     * `defaultContextPackIds` (unioned with `overrides.extraContextPackIds`)
     * in its `metadata.contextPackIds`, so agents driving the work
     * product see which packs apply.
     */
    async instantiate(
      companyId: string,
      templateId: string,
      input: InstantiateContentTemplateInput,
      actor: ActorContext,
    ): Promise<{ template: ContentTemplate; workProduct: ContentWorkProductWithLatest }> {
      const row = await getRow(companyId, templateId);
      if (!row) throw notFound("Content template not found");
      const template = toTemplate(row);

      const variables = input.variables ?? {};
      const overrides = input.overrides ?? {};

      const title = overrides.title ?? interpolateTemplate(template.titleTemplate, variables);
      if (!title || title.trim().length === 0) {
        throw unprocessable(
          "Template produced an empty title. Provide variables or an override title.",
        );
      }
      let slug: string | null = null;
      if (overrides.slug !== undefined) {
        slug = overrides.slug;
      } else if (template.slugTemplate) {
        const rendered = interpolateTemplate(template.slugTemplate, variables).trim();
        slug = rendered.length > 0 ? rendered : null;
      }

      const mergedContextPackIds = Array.from(
        new Set([
          ...template.defaultContextPackIds,
          ...(overrides.extraContextPackIds ?? []),
        ]),
      );

      const mergedTags = Array.from(
        new Set([...template.defaultTags, ...(overrides.tags ?? [])]),
      );

      const mergedMetadata: Record<string, unknown> = {
        ...template.defaultMetadata,
        ...(overrides.metadata ?? {}),
        contextPackIds: mergedContextPackIds,
        templateId: template.id,
        templateName: template.name,
      };
      if (Object.keys(template.passCriteria).length > 0) {
        mergedMetadata.passCriteria = template.passCriteria;
      }

      const status = overrides.status ?? template.defaultStatus;

      const initialBody = template.outlineBody
        ? interpolateTemplate(template.outlineBody, variables)
        : undefined;

      const workProduct = await workProducts.create(
        companyId,
        {
          projectId: overrides.projectId ?? null,
          issueId: overrides.issueId ?? null,
          type: template.type,
          kind: (template.kind === "reference" ? "reference" : "content") as "content" | "reference",
          title,
          slug,
          status,
          tags: mergedTags,
          metadata: mergedMetadata,
          ...(initialBody !== undefined
            ? {
                initialBody,
                initialFormat: "markdown" as const,
                initialChangeSummary: `Instantiated from template "${template.name}"`,
              }
            : {}),
        },
        {
          userId: actor.userId,
          agentId: actor.agentId,
          runId: actor.runId ?? null,
        },
      );

      return { template, workProduct };
    },
  };
}

export type ContentTemplateService = ReturnType<typeof contentTemplateService>;
