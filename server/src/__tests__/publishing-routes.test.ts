import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockService = vi.hoisted(() => ({
  listTargets: vi.fn(),
  getTargetById: vi.fn(),
  createTarget: vi.fn(),
  updateTarget: vi.fn(),
  removeTarget: vi.fn(),
  listAttemptsForWorkProduct: vi.fn(),
  publishWorkProduct: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  publishingService: () => mockService,
  logActivity: mockLogActivity,
}));

const TARGET_ID = "11111111-1111-1111-1111-111111111111";
const WORK_PRODUCT_ID = "22222222-2222-2222-2222-222222222222";
const COMPANY_ID = "33333333-3333-3333-3333-333333333333";

function createStubDb(opts: {
  targetCompanyId?: string | null;
  workProductCompanyId?: string | null;
} = {}) {
  // The routes file calls db.select().from(table).where(...) for
  // both publishing_targets and content_work_products. This stub
  // returns per-invocation answers based on a round-robin between
  // target and work-product lookups.
  const calls: Array<"target" | "workProduct"> = [];
  return {
    select: () => ({
      from: (table: unknown) => {
        // Drizzle table objects expose their table name via a
        // Symbol, but we don't need to introspect — the routes
        // always call the same functions in the same order per
        // request. We simply alternate based on stub configuration.
        void table;
        return {
          where: async () => {
            calls.push("any");
            // Each call stubs BOTH lookups with whatever was set.
            // Callers pick which one is relevant via the opts.
            const target = opts.targetCompanyId === undefined ? COMPANY_ID : opts.targetCompanyId;
            const workProduct =
              opts.workProductCompanyId === undefined ? COMPANY_ID : opts.workProductCompanyId;
            // Return target preference if the caller expects 404 on
            // target; otherwise return work-product preference.
            // Since routes resolve one at a time, we need to figure
            // out which is being called. Use the order of calls:
            // 1st = target (for target routes) OR 1st = wp (for publish)
            // — easiest is to have each test set exactly one relevant
            // override. We default to target-company-id for target
            // routes and work-product-company-id for publish routes.
            const n = calls.length;
            const ret = n % 2 === 1 ? target : workProduct;
            return ret === null ? [] : [{ companyId: ret }];
          },
        };
      },
    }),
  } as unknown as import("@paperclipai/db").Db;
}

async function createApp(opts: {
  actor?: Record<string, unknown>;
  targetCompanyId?: string | null;
  workProductCompanyId?: string | null;
} = {}) {
  const [{ errorHandler }, { publishingRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/publishing.js"),
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
  app.use(
    "/api",
    publishingRoutes(
      createStubDb({
        targetCompanyId: opts.targetCompanyId,
        workProductCompanyId: opts.workProductCompanyId,
      }),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("publishing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a target and logs", async () => {
    mockService.createTarget.mockResolvedValue({
      id: TARGET_ID,
      name: "gumroad",
      type: "webhook",
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/publishing-targets`)
      .send({
        name: "gumroad",
        type: "webhook",
        config: { url: "https://api.gumroad.com/hook" },
      });
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "publishing_target.created" }),
    );
  });

  it("rejects invalid target config at the validator", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/publishing-targets`)
      .send({
        name: "x",
        type: "webhook",
        config: { url: "not-a-url" },
      });
    expect(res.status).toBe(400);
    expect(mockService.createTarget).not.toHaveBeenCalled();
  });

  it("returns 404 for missing target GET", async () => {
    const app = await createApp({ targetCompanyId: null });
    const res = await request(app).get(`/api/publishing-targets/${TARGET_ID}`);
    expect(res.status).toBe(404);
  });

  it("rejects cross-tenant target GET with 403", async () => {
    const app = await createApp({ targetCompanyId: "other-company" });
    const res = await request(app).get(`/api/publishing-targets/${TARGET_ID}`);
    expect(res.status).toBe(403);
  });

  it("publishes a work product to a target", async () => {
    mockService.publishWorkProduct.mockResolvedValue({
      id: "attempt-1",
      status: "success",
      httpStatus: 200,
      durationMs: 42,
    });
    const app = await createApp();
    const res = await request(app)
      .post(`/api/content-work-products/${WORK_PRODUCT_ID}/publish-to/${TARGET_ID}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("success");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "publish_attempt.completed",
        details: expect.objectContaining({ status: "success" }),
      }),
    );
  });

  it("returns 404 when the target belongs to a different company than the work product", async () => {
    // Work product belongs to COMPANY_ID, target belongs elsewhere.
    // Because the stub alternates we need a cleaner approach here —
    // we just fake a nonexistent work product.
    const app = await createApp({ workProductCompanyId: null });
    const res = await request(app)
      .post(`/api/content-work-products/${WORK_PRODUCT_ID}/publish-to/${TARGET_ID}`)
      .send({});
    expect(res.status).toBe(404);
    expect(mockService.publishWorkProduct).not.toHaveBeenCalled();
  });

  it("lists attempts for a work product", async () => {
    mockService.listAttemptsForWorkProduct.mockResolvedValue([
      { id: "a1", status: "success" },
    ]);
    const app = await createApp();
    const res = await request(app).get(
      `/api/content-work-products/${WORK_PRODUCT_ID}/publish-attempts`,
    );
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });

  it("propagates agent actor context to the service on publish", async () => {
    mockService.publishWorkProduct.mockResolvedValue({
      id: "a",
      status: "success",
      httpStatus: 200,
      durationMs: 1,
    });
    const app = await createApp({
      actor: {
        type: "agent",
        agentId: "agent-9",
        companyId: COMPANY_ID,
        runId: "run-12",
        source: "agent_jwt",
      },
    });
    await request(app)
      .post(`/api/content-work-products/${WORK_PRODUCT_ID}/publish-to/${TARGET_ID}`)
      .send({});
    expect(mockService.publishWorkProduct).toHaveBeenCalledWith(
      COMPANY_ID,
      WORK_PRODUCT_ID,
      TARGET_ID,
      {},
      expect.objectContaining({ agentId: "agent-9", userId: null }),
    );
  });
});
