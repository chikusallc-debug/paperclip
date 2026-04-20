import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createContentTemplateSchema,
  updateContentTemplateSchema,
  instantiateContentTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  contentTemplateService,
  logActivity,
  type ListContentTemplatesFilters,
} from "../services/index.js";

function parseFilters(query: Record<string, unknown>): ListContentTemplatesFilters {
  const filters: ListContentTemplatesFilters = {};
  if (typeof query.type === "string") filters.type = query.type;
  if (typeof query.kind === "string") filters.kind = query.kind;
  return filters;
}

export function contentTemplateRoutes(db: Db) {
  const router = Router();
  const svc = contentTemplateService(db);

  router.get("/companies/:companyId/content-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.list(companyId, parseFilters(req.query as Record<string, unknown>));
    res.json(items);
  });

  router.post(
    "/companies/:companyId/content-templates",
    validate(createContentTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const template = await svc.create(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_template.created",
        entityType: "content_template",
        entityId: template.id,
        details: { name: template.name, type: template.type, kind: template.kind },
      });
      res.status(201).json(template);
    },
  );

  router.get("/content-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content template not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const template = await svc.getById(companyId, id);
    if (!template) {
      res.status(404).json({ error: "Content template not found" });
      return;
    }
    res.json(template);
  });

  router.patch(
    "/content-templates/:id",
    validate(updateContentTemplateSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content template not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const template = await svc.update(companyId, id, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_template.updated",
        entityType: "content_template",
        entityId: template.id,
        details: { patch: req.body },
      });
      res.json(template);
    },
  );

  router.delete("/content-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content template not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await svc.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "content_template.deleted",
      entityType: "content_template",
      entityId: id,
      details: {},
    });
    res.status(204).send();
  });

  router.post(
    "/content-templates/:id/instantiate",
    validate(instantiateContentTemplateSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content template not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.instantiate(companyId, id, req.body ?? {}, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
        runId: actor.runId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_template.instantiated",
        entityType: "content_work_product",
        entityId: result.workProduct.id,
        details: {
          templateId: result.template.id,
          templateName: result.template.name,
          workProductId: result.workProduct.id,
          workProductTitle: result.workProduct.title,
        },
      });
      res.status(201).json(result);
    },
  );

  return router;
}

async function resolveCompanyId(db: Db, id: string): Promise<string | null> {
  const { contentTemplates } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: contentTemplates.companyId })
    .from(contentTemplates)
    .where(eq(contentTemplates.id, id));
  return rows[0]?.companyId ?? null;
}
