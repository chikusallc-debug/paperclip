import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createContentWorkProductSchema,
  updateContentWorkProductSchema,
  createContentWorkProductVersionSchema,
  publishContentWorkProductSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  contentWorkProductService,
  logActivity,
  type ListContentWorkProductsFilters,
} from "../services/index.js";

/**
 * Pass-criteria bypass is board-only. Agents must never bypass their
 * own content rules; the factory relies on them being enforced to
 * prevent an autonomous run from shipping junk. We surface this as a
 * query param (`?bypass=true`) so it's explicit in the audit log URL.
 */
function resolveGateBypass(req: import("express").Request): { bypass: boolean } {
  const raw = typeof req.query.bypass === "string" ? req.query.bypass : null;
  if (raw !== "true") return { bypass: false };
  if (req.actor?.type !== "board") return { bypass: false };
  return { bypass: true };
}

function parseFilters(query: Record<string, unknown>): ListContentWorkProductsFilters {
  const filters: ListContentWorkProductsFilters = {};
  if (typeof query.projectId === "string") {
    filters.projectId = query.projectId === "null" ? null : query.projectId;
  }
  if (typeof query.issueId === "string") {
    filters.issueId = query.issueId === "null" ? null : query.issueId;
  }
  if (typeof query.type === "string") filters.type = query.type;
  if (typeof query.status === "string") filters.status = query.status;
  if (typeof query.kind === "string") filters.kind = query.kind;
  return filters;
}

export function contentWorkProductRoutes(db: Db) {
  const router = Router();
  const svc = contentWorkProductService(db);

  router.get("/companies/:companyId/content-work-products", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.list(companyId, parseFilters(req.query as Record<string, unknown>));
    res.json(items);
  });

  router.post(
    "/companies/:companyId/content-work-products",
    validate(createContentWorkProductSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const created = await svc.create(
        companyId,
        req.body,
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
          runId: actor.runId,
        },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_work_product.created",
        entityType: "content_work_product",
        entityId: created.id,
        details: {
          type: created.type,
          kind: created.kind,
          title: created.title,
          status: created.status,
          hasInitialVersion: created.latestVersion !== null,
        },
      });

      res.status(201).json(created);
    },
  );

  router.get("/content-work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const wp = await svc.getWithLatest(companyId, id);
    if (!wp) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    res.json(wp);
  });

  router.patch(
    "/content-work-products/:id",
    validate(updateContentWorkProductSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content work product not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const gate = resolveGateBypass(req);
      const updated = await svc.update(
        companyId,
        id,
        req.body,
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
        },
        gate,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_work_product.updated",
        entityType: "content_work_product",
        entityId: updated.id,
        details: { patch: req.body, gateBypass: gate.bypass || undefined },
      });

      res.json(updated);
    },
  );

  router.delete("/content-work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    await svc.remove(companyId, id);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "content_work_product.deleted",
      entityType: "content_work_product",
      entityId: id,
      details: {},
    });

    res.status(204).send();
  });

  router.get("/content-work-products/:id/versions", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const versions = await svc.listVersions(companyId, id);
    res.json(versions);
  });

  router.post(
    "/content-work-products/:id/versions",
    validate(createContentWorkProductVersionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content work product not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const gate = resolveGateBypass(req);
      const version = await svc.addVersion(
        companyId,
        id,
        req.body,
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
          runId: actor.runId,
        },
        gate,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_work_product.version_added",
        entityType: "content_work_product",
        entityId: id,
        details: {
          versionNumber: version.versionNumber,
          changeSummary: version.changeSummary,
          advancedStatusTo: req.body.advanceStatusTo ?? null,
          gateBypass: gate.bypass || undefined,
        },
      });

      res.status(201).json(version);
    },
  );

  router.get(
    "/content-work-products/:id/versions/:versionNumber",
    async (req, res) => {
      const id = req.params.id as string;
      const versionNumber = Number(req.params.versionNumber);
      if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
        res.status(400).json({ error: "versionNumber must be a positive integer" });
        return;
      }
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content work product not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const version = await svc.getVersion(companyId, id, versionNumber);
      res.json(version);
    },
  );

  router.post(
    "/content-work-products/:id/publish",
    validate(publishContentWorkProductSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyId(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Content work product not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const gate = resolveGateBypass(req);
      const updated = await svc.publish(
        companyId,
        id,
        req.body ?? {},
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
        },
        gate,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "content_work_product.published",
        entityType: "content_work_product",
        entityId: id,
        details: {
          publishedVersionId: updated.publishedVersionId,
          requestedVersionNumber: req.body?.versionNumber ?? null,
          gateBypass: gate.bypass || undefined,
        },
      });

      res.json(updated);
    },
  );

  // Pass-criteria dry-run. Safe to call repeatedly — no side effects.
  // Returns the current latest-version evaluation so agents and
  // operators can see exactly which rules are blocking advancement
  // (and the underlying stats like wordcount) before requesting a
  // status transition.
  router.get("/content-work-products/:id/pass-criteria", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyId(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const evaluation = await svc.evaluateCriteria(companyId, id);
    res.json(evaluation);
  });

  return router;
}

/**
 * Resolves the owning companyId for a content work product id. Returns null
 * when no such row exists. Kept local to the routes module — authz always
 * runs after resolution.
 */
async function resolveCompanyId(db: Db, id: string): Promise<string | null> {
  const { contentWorkProducts } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: contentWorkProducts.companyId })
    .from(contentWorkProducts)
    .where(eq(contentWorkProducts.id, id));
  return rows[0]?.companyId ?? null;
}
