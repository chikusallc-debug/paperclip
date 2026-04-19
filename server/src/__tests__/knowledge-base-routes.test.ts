import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockKb = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByPath: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upsertByPath: vi.fn(),
  remove: vi.fn(),
  resolveRules: vi.fn(),
  combineRules: vi.fn((a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) })),
}));

const mockPacks = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  resolve: vi.fn(),
  resolveAdHoc: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  knowledgeBaseService: () => mockKb,
  contextPackService: () => mockPacks,
  logActivity: mockLogActivity,
}));

const DOC_ID = "11111111-1111-1111-1111-111111111111";
const PACK_ID = "22222222-2222-2222-2222-222222222222";
const COMPANY_ID = "33333333-3333-3333-3333-333333333333";

/**
 * The route handlers do a companyId lookup via `db.select().from(...).where(...)`
 * for both docs and packs. The stub returns the same default companyId for
 * every lookup; tests that need 404 or cross-tenant paths pass an override
 * companyId. The override is per-app, not per-entity; tests that need to
 * distinguish doc vs pack lookups can override one at a time.
 */
function createStubDb(opts: { companyIdOverride?: string | null } = {}) {
  const resolveResponse = async () => {
    if (opts.companyIdOverride === null) return [];
    return [{ companyId: opts.companyIdOverride ?? COMPANY_ID }];
  };
  return {
    select: () => ({
      from: () => ({
        where: resolveResponse,
      }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

async function createApp(opts: {
  actor?: Record<string, unknown>;
  companyIdOverride?: string | null;
} = {}) {
  const [{ errorHandler }, { knowledgeBaseRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/knowledge-base.js"),
  ]);
  const app = express();
  app.use(express.json());
  const actor = opts.actor ?? {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "operator" }],
  };
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", knowledgeBaseRoutes(createStubDb({ companyIdOverride: opts.companyIdOverride })));
  app.use(errorHandler);
  return app;
}

describe("knowledge base routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /companies/:id/knowledge-base-documents", () => {
    it("creates a doc and logs activity", async () => {
      mockKb.create.mockResolvedValue({
        id: DOC_ID,
        path: "characters/elena.md",
        kind: "character",
        projectId: null,
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/knowledge-base-documents`)
        .send({
          path: "characters/elena.md",
          title: "Elena Rostova",
          kind: "character",
          body: "# Elena",
        });
      expect(res.status).toBe(201);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "knowledge_base_document.created" }),
      );
    });

    it("rejects bad paths", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/knowledge-base-documents`)
        .send({ path: "/absolute/bad.md", title: "X", body: "x" });
      expect(res.status).toBe(400);
      expect(mockKb.create).not.toHaveBeenCalled();
    });
  });

  describe("PUT /companies/:id/knowledge-base-documents/by-path", () => {
    it("returns 201 on create and 200 on update", async () => {
      mockKb.upsertByPath
        .mockResolvedValueOnce({ doc: { id: DOC_ID, path: "x.md", projectId: null }, created: true })
        .mockResolvedValueOnce({ doc: { id: DOC_ID, path: "x.md", projectId: null }, created: false });

      const app = await createApp();
      const first = await request(app)
        .put(`/api/companies/${COMPANY_ID}/knowledge-base-documents/by-path`)
        .send({ path: "x.md", title: "X", body: "first" });
      const second = await request(app)
        .put(`/api/companies/${COMPANY_ID}/knowledge-base-documents/by-path`)
        .send({ path: "x.md", title: "X", body: "second" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
    });
  });

  describe("GET /knowledge-base-documents/:id", () => {
    it("returns 404 when the doc does not exist", async () => {
      const app = await createApp({ companyIdOverride: null });
      const res = await request(app).get(`/api/knowledge-base-documents/${DOC_ID}`);
      expect(res.status).toBe(404);
    });

    it("rejects cross-tenant GETs", async () => {
      const app = await createApp({ companyIdOverride: "another-company" });
      const res = await request(app).get(`/api/knowledge-base-documents/${DOC_ID}`);
      expect(res.status).toBe(403);
    });

    it("returns the doc when the caller has access", async () => {
      mockKb.getById.mockResolvedValue({ id: DOC_ID, path: "x.md", body: "ok" });
      const app = await createApp();
      const res = await request(app).get(`/api/knowledge-base-documents/${DOC_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.body).toBe("ok");
    });
  });

  describe("POST /companies/:id/context-packs", () => {
    it("creates a pack and logs", async () => {
      mockPacks.create.mockResolvedValue({
        id: PACK_ID,
        name: "chapter-1",
        projectId: null,
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/context-packs`)
        .send({
          name: "chapter-1",
          description: "Everything an agent needs",
          rules: { includeKinds: ["character"] },
        });
      expect(res.status).toBe(201);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "context_pack.created" }),
      );
    });

    it("rejects non-kebab-case pack names", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/context-packs`)
        .send({ name: "Chapter 1" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /context-packs/:id/resolve", () => {
    it("resolves a saved pack", async () => {
      mockPacks.resolve.mockResolvedValue({
        packId: PACK_ID,
        name: "chapter-1",
        documents: [{ path: "characters/elena.md", body: "E" }],
        totalMatched: 1,
        truncated: false,
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/context-packs/${PACK_ID}/resolve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.documents.length).toBe(1);
    });

    it("accepts overrideRules", async () => {
      mockPacks.resolve.mockResolvedValue({
        packId: PACK_ID,
        name: "chapter-1",
        documents: [],
        totalMatched: 0,
        truncated: false,
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/context-packs/${PACK_ID}/resolve`)
        .send({ overrideRules: { includePaths: ["characters/x.md"] } });
      expect(res.status).toBe(200);
      expect(mockPacks.resolve).toHaveBeenCalledWith(
        COMPANY_ID,
        PACK_ID,
        expect.objectContaining({
          overrideRules: { includePaths: ["characters/x.md"] },
        }),
      );
    });

    it("returns 404 for unknown packs", async () => {
      const app = await createApp({ companyIdOverride: null });
      const res = await request(app)
        .post(`/api/context-packs/${PACK_ID}/resolve`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe("POST /companies/:id/context-packs/preview", () => {
    it("previews resolution without saving a pack", async () => {
      mockPacks.resolveAdHoc.mockResolvedValue({
        packId: null,
        name: "ad-hoc",
        documents: [{ path: "characters/elena.md", body: "E" }],
        totalMatched: 1,
        truncated: false,
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/context-packs/preview`)
        .send({ includePaths: ["characters/elena.md"] });
      expect(res.status).toBe(200);
      expect(res.body.packId).toBeNull();
    });

    it("rejects invalid rules at the validator", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/context-packs/preview`)
        .send({ maxDocs: -10 });
      expect(res.status).toBe(400);
    });
  });

  it("accepts agent actors and propagates runId via knowledge-base create", async () => {
    mockKb.create.mockResolvedValue({ id: DOC_ID, path: "characters/x.md", kind: "character", projectId: null });
    const app = await createApp({
      actor: {
        type: "agent",
        agentId: "agent-9",
        companyId: COMPANY_ID,
        runId: "run-77",
        source: "agent_jwt",
      },
    });
    await request(app)
      .post(`/api/companies/${COMPANY_ID}/knowledge-base-documents`)
      .send({ path: "characters/x.md", title: "X", body: "x" });
    expect(mockKb.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.anything(),
      expect.objectContaining({ agentId: "agent-9", userId: null }),
    );
  });
});
