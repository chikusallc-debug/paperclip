import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  instantiate: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  contentTemplateService: () => mockService,
  logActivity: mockLogActivity,
}));

const TEMPLATE_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

function createStubDb(opts: { companyIdOverride?: string | null } = {}) {
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          if (opts.companyIdOverride === null) return [];
          return [{ companyId: opts.companyIdOverride ?? COMPANY_ID }];
        },
      }),
    }),
  } as unknown as import("@paperclipai/db").Db;
}

async function createApp(opts: {
  actor?: Record<string, unknown>;
  companyIdOverride?: string | null;
} = {}) {
  const [{ errorHandler }, { contentTemplateRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/content-templates.js"),
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
  app.use("/api", contentTemplateRoutes(createStubDb({ companyIdOverride: opts.companyIdOverride })));
  app.use(errorHandler);
  return app;
}

describe("content template routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a template and logs activity", async () => {
    mockService.create.mockResolvedValue({
      id: TEMPLATE_ID,
      name: "novel-chapter",
      type: "novel_chapter",
      kind: "content",
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/content-templates`)
      .send({
        name: "novel-chapter",
        type: "novel_chapter",
        titleTemplate: "Chapter {{n}}: {{title}}",
        slugTemplate: "chapter-{{n}}",
        defaultTags: ["novel"],
        outlineBody: "# Chapter {{n}}\n\nTODO",
      });
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "content_template.created" }),
    );
  });

  it("rejects non-kebab names", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/content-templates`)
      .send({ name: "Not Kebab", type: "t", titleTemplate: "T" });
    expect(res.status).toBe(400);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown templates", async () => {
    const app = await createApp({ companyIdOverride: null });
    const res = await request(app).get(`/api/content-templates/${TEMPLATE_ID}`);
    expect(res.status).toBe(404);
  });

  it("rejects cross-tenant GETs with 403", async () => {
    const app = await createApp({ companyIdOverride: "another-company" });
    const res = await request(app).get(`/api/content-templates/${TEMPLATE_ID}`);
    expect(res.status).toBe(403);
  });

  it("instantiates a template and returns the new work product", async () => {
    mockService.instantiate.mockResolvedValue({
      template: { id: TEMPLATE_ID, name: "novel-chapter" },
      workProduct: {
        id: "wp-1",
        title: "Chapter 12: Arrival",
        slug: "chapter-12",
        type: "novel_chapter",
        latestVersion: { versionNumber: 1 },
      },
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/content-templates/${TEMPLATE_ID}/instantiate`)
      .send({
        variables: { n: 12, title: "Arrival" },
        overrides: { projectId: "33333333-3333-3333-3333-333333333333" },
      });
    expect(res.status).toBe(201);
    expect(res.body.workProduct.id).toBe("wp-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "content_template.instantiated",
        details: expect.objectContaining({ templateName: "novel-chapter" }),
      }),
    );
  });

  it("rejects unknown overrides keys on instantiate", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/content-templates/${TEMPLATE_ID}/instantiate`)
      .send({ overrides: { bogus: "x" } });
    expect(res.status).toBe(400);
  });

  it("propagates agent actor context through instantiate", async () => {
    mockService.instantiate.mockResolvedValue({
      template: { id: TEMPLATE_ID, name: "t" },
      workProduct: { id: "wp-x" },
    });
    const app = await createApp({
      actor: {
        type: "agent",
        agentId: "agent-7",
        companyId: COMPANY_ID,
        runId: "run-99",
        source: "agent_jwt",
      },
    });
    await request(app)
      .post(`/api/content-templates/${TEMPLATE_ID}/instantiate`)
      .send({ variables: { n: 1 } });
    expect(mockService.instantiate).toHaveBeenCalledWith(
      COMPANY_ID,
      TEMPLATE_ID,
      expect.objectContaining({ variables: { n: 1 } }),
      expect.objectContaining({ agentId: "agent-7", runId: "run-99", userId: null }),
    );
  });

  it("lists with filters", async () => {
    mockService.list.mockResolvedValue([]);
    const app = await createApp();
    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/content-templates?type=novel_chapter&kind=content`,
    );
    expect(res.status).toBe(200);
    expect(mockService.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ type: "novel_chapter", kind: "content" }),
    );
  });
});
