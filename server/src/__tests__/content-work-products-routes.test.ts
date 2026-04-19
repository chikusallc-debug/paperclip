import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getWithLatest: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  addVersion: vi.fn(),
  publish: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  contentWorkProductService: () => mockService,
  logActivity: mockLogActivity,
}));

// Stub the dynamic import used by resolveCompanyId in the route handlers.
vi.mock("@paperclipai/db", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/db")>("@paperclipai/db");
  return actual;
});

const FAKE_WP_ID = "11111111-1111-1111-1111-111111111111";
const FAKE_COMPANY_ID = "22222222-2222-2222-2222-222222222222";

function createStubDb(options: { ownerCompanyId?: string | null } = {}) {
  const { ownerCompanyId = FAKE_COMPANY_ID } = options;
  return {
    select: () => ({
      from: () => ({
        where: async () =>
          ownerCompanyId === null ? [] : [{ companyId: ownerCompanyId }],
      }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

async function createApp(opts: {
  actor?: Record<string, unknown>;
  ownerCompanyId?: string | null;
} = {}) {
  const [{ errorHandler }, { contentWorkProductRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/content-work-products.js"),
  ]);
  const app = express();
  app.use(express.json());
  const actor = opts.actor ?? {
    type: "board",
    userId: "user-1",
    companyIds: [FAKE_COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
    memberships: [
      { companyId: FAKE_COMPANY_ID, status: "active", membershipRole: "operator" },
    ],
  };
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", contentWorkProductRoutes(createStubDb({ ownerCompanyId: opts.ownerCompanyId })));
  app.use(errorHandler);
  return app;
}

describe("content work product routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a content work product and logs activity", async () => {
    mockService.create.mockResolvedValue({
      id: FAKE_WP_ID,
      type: "novel_chapter",
      kind: "content",
      title: "Chapter 1",
      status: "draft",
      latestVersion: null,
    });
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${FAKE_COMPANY_ID}/content-work-products`)
      .send({
        type: "novel_chapter",
        title: "Chapter 1",
        initialBody: "# Chapter 1",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FAKE_WP_ID);
    expect(mockService.create).toHaveBeenCalledWith(
      FAKE_COMPANY_ID,
      expect.objectContaining({ type: "novel_chapter", title: "Chapter 1" }),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "content_work_product.created",
        entityId: FAKE_WP_ID,
      }),
    );
  });

  it("rejects invalid slug formats at the validator", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${FAKE_COMPANY_ID}/content-work-products`)
      .send({
        type: "novel_chapter",
        title: "Chapter 1",
        slug: "Bad Slug With Spaces",
      });
    expect(res.status).toBe(400);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it("gets a work product with latest version", async () => {
    mockService.getWithLatest.mockResolvedValue({
      id: FAKE_WP_ID,
      title: "Chapter 1",
      latestVersion: { versionNumber: 2, body: "v2" },
    });
    const app = await createApp();
    const res = await request(app).get(`/api/content-work-products/${FAKE_WP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.latestVersion.versionNumber).toBe(2);
  });

  it("returns 404 when work product does not exist", async () => {
    const app = await createApp({ ownerCompanyId: null });
    const res = await request(app).get(`/api/content-work-products/${FAKE_WP_ID}`);
    expect(res.status).toBe(404);
  });

  it("rejects cross-tenant GETs", async () => {
    const otherCompany = "33333333-3333-3333-3333-333333333333";
    const app = await createApp({ ownerCompanyId: otherCompany });
    const res = await request(app).get(`/api/content-work-products/${FAKE_WP_ID}`);
    expect(res.status).toBe(403);
  });

  it("creates a new version and logs activity", async () => {
    mockService.addVersion.mockResolvedValue({
      id: "v2-id",
      workProductId: FAKE_WP_ID,
      versionNumber: 2,
      body: "v2 body",
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/content-work-products/${FAKE_WP_ID}/versions`)
      .send({ body: "v2 body", changeSummary: "tightened pacing", advanceStatusTo: "in_review" });

    expect(res.status).toBe(201);
    expect(res.body.versionNumber).toBe(2);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "content_work_product.version_added",
        details: expect.objectContaining({
          versionNumber: 2,
          advancedStatusTo: "in_review",
        }),
      }),
    );
  });

  it("publishes with an empty body defaults to latest", async () => {
    mockService.publish.mockResolvedValue({
      id: FAKE_WP_ID,
      status: "published",
      publishedVersionId: "v3-id",
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/content-work-products/${FAKE_WP_ID}/publish`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
    expect(mockService.publish).toHaveBeenCalledWith(
      FAKE_COMPANY_ID,
      FAKE_WP_ID,
      {},
      expect.anything(),
    );
  });

  it("rejects extra properties on PATCH (strict validator)", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch(`/api/content-work-products/${FAKE_WP_ID}`)
      .send({ title: "X", initialBody: "should not be accepted here" });
    expect(res.status).toBe(400);
  });

  it("returns a specific version by version number", async () => {
    mockService.getVersion.mockResolvedValue({
      id: "v1",
      workProductId: FAKE_WP_ID,
      versionNumber: 1,
      body: "first",
    });
    const app = await createApp();
    const res = await request(app).get(
      `/api/content-work-products/${FAKE_WP_ID}/versions/1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("first");
  });

  it("rejects non-integer versionNumber path params", async () => {
    const app = await createApp();
    const res = await request(app).get(
      `/api/content-work-products/${FAKE_WP_ID}/versions/latest`,
    );
    expect(res.status).toBe(400);
  });

  it("lists with filters", async () => {
    mockService.list.mockResolvedValue([
      { id: "wp-1", type: "novel_chapter", status: "draft" },
    ]);
    const app = await createApp();
    const res = await request(app).get(
      `/api/companies/${FAKE_COMPANY_ID}/content-work-products?type=novel_chapter&status=draft`,
    );
    expect(res.status).toBe(200);
    expect(mockService.list).toHaveBeenCalledWith(
      FAKE_COMPANY_ID,
      expect.objectContaining({ type: "novel_chapter", status: "draft" }),
    );
  });

  it("passes agent actor context to the service", async () => {
    mockService.create.mockResolvedValue({ id: FAKE_WP_ID, latestVersion: null });
    const app = await createApp({
      actor: {
        type: "agent",
        agentId: "agent-7",
        companyId: FAKE_COMPANY_ID,
        runId: "run-42",
        source: "agent_jwt",
      },
    });

    await request(app)
      .post(`/api/companies/${FAKE_COMPANY_ID}/content-work-products`)
      .send({ type: "novel_chapter", title: "C1" });

    expect(mockService.create).toHaveBeenCalledWith(
      FAKE_COMPANY_ID,
      expect.anything(),
      expect.objectContaining({ agentId: "agent-7", runId: "run-42", userId: null }),
    );
  });
});
