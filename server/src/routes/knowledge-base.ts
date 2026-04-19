import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createKnowledgeBaseDocumentSchema,
  updateKnowledgeBaseDocumentSchema,
  upsertKnowledgeBaseDocumentSchema,
  createContextPackSchema,
  updateContextPackSchema,
  resolveContextPackSchema,
  contextPackRulesSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  contextPackService,
  knowledgeBaseService,
  logActivity,
  type ListContextPacksFilters,
  type ListKnowledgeBaseDocumentsFilters,
} from "../services/index.js";

function parseKbFilters(query: Record<string, unknown>): ListKnowledgeBaseDocumentsFilters {
  const filters: ListKnowledgeBaseDocumentsFilters = {};
  if (typeof query.projectId === "string") {
    filters.projectId = query.projectId === "null" ? null : query.projectId;
  }
  if (typeof query.kind === "string") filters.kind = query.kind;
  if (typeof query.tag === "string") filters.tag = query.tag;
  if (typeof query.pathPrefix === "string") filters.pathPrefix = query.pathPrefix;
  return filters;
}

function parsePackFilters(query: Record<string, unknown>): ListContextPacksFilters {
  const filters: ListContextPacksFilters = {};
  if (typeof query.projectId === "string") {
    filters.projectId = query.projectId === "null" ? null : query.projectId;
  }
  return filters;
}

export function knowledgeBaseRoutes(db: Db) {
  const router = Router();
  const kb = knowledgeBaseService(db);
  const packs = contextPackService(db);

  // ------- Knowledge base documents -------

  router.get("/companies/:companyId/knowledge-base-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const docs = await kb.list(companyId, parseKbFilters(req.query as Record<string, unknown>));
    res.json(docs);
  });

  router.post(
    "/companies/:companyId/knowledge-base-documents",
    validate(createKnowledgeBaseDocumentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const doc = await kb.create(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "knowledge_base_document.created",
        entityType: "knowledge_base_document",
        entityId: doc.id,
        details: { path: doc.path, kind: doc.kind, projectId: doc.projectId },
      });
      res.status(201).json(doc);
    },
  );

  // Idempotent upsert-by-path: POST the same payload twice and the
  // second call updates (rather than 409-ing).
  router.put(
    "/companies/:companyId/knowledge-base-documents/by-path",
    validate(upsertKnowledgeBaseDocumentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await kb.upsertByPath(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: result.created
          ? "knowledge_base_document.created"
          : "knowledge_base_document.updated",
        entityType: "knowledge_base_document",
        entityId: result.doc.id,
        details: { path: result.doc.path, projectId: result.doc.projectId },
      });
      res.status(result.created ? 201 : 200).json(result.doc);
    },
  );

  router.get("/knowledge-base-documents/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForDoc(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Knowledge base document not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const doc = await kb.getById(companyId, id);
    if (!doc) {
      res.status(404).json({ error: "Knowledge base document not found" });
      return;
    }
    res.json(doc);
  });

  router.patch(
    "/knowledge-base-documents/:id",
    validate(updateKnowledgeBaseDocumentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyIdForDoc(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Knowledge base document not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const doc = await kb.update(companyId, id, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "knowledge_base_document.updated",
        entityType: "knowledge_base_document",
        entityId: doc.id,
        details: { path: doc.path, patch: req.body },
      });
      res.json(doc);
    },
  );

  router.delete("/knowledge-base-documents/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForDoc(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Knowledge base document not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await kb.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "knowledge_base_document.deleted",
      entityType: "knowledge_base_document",
      entityId: id,
      details: {},
    });
    res.status(204).send();
  });

  // ------- Context packs -------

  router.get("/companies/:companyId/context-packs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await packs.list(companyId, parsePackFilters(req.query as Record<string, unknown>));
    res.json(items);
  });

  router.post(
    "/companies/:companyId/context-packs",
    validate(createContextPackSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const pack = await packs.create(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "context_pack.created",
        entityType: "context_pack",
        entityId: pack.id,
        details: { name: pack.name, projectId: pack.projectId },
      });
      res.status(201).json(pack);
    },
  );

  /**
   * Preview a pack resolution without saving it. Useful for agents that
   * want to sanity-check a rule set before committing it to a pack.
   */
  router.post(
    "/companies/:companyId/context-packs/preview",
    validate(contextPackRulesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectIdRaw = req.query.projectId;
      const projectId =
        typeof projectIdRaw === "string" && projectIdRaw !== "null"
          ? projectIdRaw
          : null;
      const resolution = await packs.resolveAdHoc(companyId, projectId, req.body);
      res.json(resolution);
    },
  );

  router.get("/context-packs/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForPack(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Context pack not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const pack = await packs.getById(companyId, id);
    if (!pack) {
      res.status(404).json({ error: "Context pack not found" });
      return;
    }
    res.json(pack);
  });

  router.patch(
    "/context-packs/:id",
    validate(updateContextPackSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyIdForPack(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Context pack not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const pack = await packs.update(companyId, id, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "context_pack.updated",
        entityType: "context_pack",
        entityId: pack.id,
        details: { patch: req.body },
      });
      res.json(pack);
    },
  );

  router.delete("/context-packs/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForPack(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Context pack not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await packs.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "context_pack.deleted",
      entityType: "context_pack",
      entityId: id,
      details: {},
    });
    res.status(204).send();
  });

  router.post(
    "/context-packs/:id/resolve",
    validate(resolveContextPackSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyIdForPack(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Context pack not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const resolution = await packs.resolve(companyId, id, req.body ?? {});
      res.json(resolution);
    },
  );

  return router;
}

async function resolveCompanyIdForDoc(db: Db, id: string): Promise<string | null> {
  const { knowledgeBaseDocuments } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: knowledgeBaseDocuments.companyId })
    .from(knowledgeBaseDocuments)
    .where(eq(knowledgeBaseDocuments.id, id));
  return rows[0]?.companyId ?? null;
}

async function resolveCompanyIdForPack(db: Db, id: string): Promise<string | null> {
  const { contextPacks } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: contextPacks.companyId })
    .from(contextPacks)
    .where(eq(contextPacks.id, id));
  return rows[0]?.companyId ?? null;
}
