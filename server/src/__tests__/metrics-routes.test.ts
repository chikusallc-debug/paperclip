import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { metricsRoutes, renderPrometheusText } from "../routes/metrics.js";

const ORIGINAL_ENV = { ...process.env };

function createDbStub(
  byStatus: Record<string, Record<string, number>> = {},
): Db {
  // The service issues three distinct groupBy queries (total heartbeat
  // runs, active heartbeat runs, publish attempts). The stub uses a
  // rolling pointer so each .select().from().where()/.groupBy()
  // returns the next configured shape.
  const order: Array<"heartbeat_total" | "heartbeat_active" | "publish"> = [
    "heartbeat_total",
    "heartbeat_active",
    "publish",
  ];
  let i = 0;
  const respond = () => {
    const which = order[i++] ?? "heartbeat_total";
    const source =
      which === "heartbeat_total"
        ? byStatus.heartbeat ?? {}
        : which === "heartbeat_active"
          ? byStatus.active ?? {}
          : byStatus.publish ?? {};
    return Object.entries(source).map(([status, count]) => ({ status, count }));
  };

  const chain = {
    where: (_: unknown) => ({
      groupBy: async () => respond(),
    }),
    groupBy: async () => respond(),
  };

  return {
    select: () => ({
      from: () => chain,
    }),
  } as unknown as Db;
}

async function mountApp(db: Db | undefined, actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  companyIds: [],
  source: "session",
  isInstanceAdmin: true,
}) {
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/metrics", metricsRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("renderPrometheusText", () => {
  it("emits HELP/TYPE lines and samples with labels", () => {
    const out = renderPrometheusText([
      {
        name: "paperclip_test",
        help: "A test metric.",
        type: "counter",
        samples: [
          { labels: { status: "ok" }, value: 3 },
          { labels: { status: "fail" }, value: 1 },
        ],
      },
    ]);
    expect(out).toContain("# HELP paperclip_test A test metric.");
    expect(out).toContain("# TYPE paperclip_test counter");
    expect(out).toContain('paperclip_test{status="ok"} 3');
    expect(out).toContain('paperclip_test{status="fail"} 1');
    // Must end with a newline per exposition spec.
    expect(out.endsWith("\n")).toBe(true);
  });

  it("renders labelless samples without braces", () => {
    const out = renderPrometheusText([
      {
        name: "paperclip_bare",
        help: "No labels.",
        type: "gauge",
        samples: [{ labels: {}, value: 42 }],
      },
    ]);
    expect(out).toContain("paperclip_bare 42");
    expect(out).not.toContain("paperclip_bare{}");
  });

  it("escapes backslashes, newlines, and quotes in label values", () => {
    const out = renderPrometheusText([
      {
        name: "m",
        help: "h",
        type: "gauge",
        samples: [
          {
            labels: { path: 'C:\\temp\n"q"' },
            value: 1,
          },
        ],
      },
    ]);
    expect(out).toContain('path="C:\\\\temp\\n\\"q\\""');
  });
});

describe("GET /metrics", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("returns 200 with Prometheus content-type for a board actor", async () => {
    const app = await mountApp(
      createDbStub({
        heartbeat: { succeeded: 12, failed: 1 },
        active: { queued: 2, running: 1 },
        publish: { success: 5, failed: 0, pending: 1 },
      }),
    );
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain.*version=0\.0\.4/);
    expect(res.text).toContain("paperclip_heartbeat_runs_total");
    expect(res.text).toContain("paperclip_heartbeat_runs_active");
    expect(res.text).toContain("paperclip_publish_attempts_total");
    expect(res.text).toContain("paperclip_process_resident_memory_bytes");
    expect(res.text).toContain("paperclip_build_info");
  });

  it("exposes heartbeat status counts from the DB stub", async () => {
    const app = await mountApp(
      createDbStub({
        heartbeat: { succeeded: 12, failed: 1 },
        active: { queued: 2 },
        publish: {},
      }),
    );
    const res = await request(app).get("/metrics");
    expect(res.text).toMatch(/paperclip_heartbeat_runs_total\{status="succeeded"\} 12/);
    expect(res.text).toMatch(/paperclip_heartbeat_runs_total\{status="failed"\} 1/);
    // The active metric must always emit both known statuses (even
    // if only one is non-zero) so Grafana panels don't show "no data".
    expect(res.text).toMatch(/paperclip_heartbeat_runs_active\{status="queued"\} 2/);
    expect(res.text).toMatch(/paperclip_heartbeat_runs_active\{status="running"\} 0/);
  });

  it("rejects non-board actors with 403", async () => {
    const app = await mountApp(createDbStub(), {
      type: "agent",
      agentId: "a1",
      companyId: "c1",
      source: "agent_jwt",
    });
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(403);
  });

  it("rejects anonymous actors with 403 (board required)", async () => {
    const app = await mountApp(createDbStub(), { type: "none", source: "none" });
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(403);
  });

  it("returns 404 when PAPERCLIP_METRICS_DISABLED=true (env-gated off switch)", async () => {
    process.env.PAPERCLIP_METRICS_DISABLED = "true";
    const app = await mountApp(createDbStub());
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);
    expect(res.text).toContain("metrics disabled");
  });

  it("still exposes process + build info even with no db handle", async () => {
    const app = await mountApp(undefined);
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("paperclip_process_heap_used_bytes");
    expect(res.text).toContain("paperclip_build_info");
    // No db-backed metrics should appear.
    expect(res.text).not.toContain("paperclip_heartbeat_runs_total");
  });
});
