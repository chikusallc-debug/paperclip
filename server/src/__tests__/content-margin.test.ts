import { describe, expect, it, vi } from "vitest";
import { contentMarginService } from "../services/content-margin.ts";

/**
 * contentMarginService is thin orchestration around a DB sum and
 * the wp service. Unit-test focuses on the arithmetic edge cases
 * (missing listPrice, zero cost, unitsTarget projection,
 * break-even) rather than the Drizzle query shape.
 */

const mockWp = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/content-work-products.js", () => ({
  contentWorkProductService: () => mockWp,
}));

type FakeRow = { total: number; count: number } | { key: string | null; total: number };

function makeDbStub(totals: {
  total: number;
  count: number;
  byProvider: Array<{ key: string; total: number }>;
  byAgent: Array<{ key: string; total: number }>;
  byModel: Array<{ key: string; total: number }>;
}) {
  // The service issues four queries in order:
  //   1. aggregate total + count
  //   2. breakdown by provider
  //   3. breakdown by agent
  //   4. breakdown by model
  const queue: FakeRow[][] = [
    [{ total: totals.total, count: totals.count }],
    totals.byProvider,
    totals.byAgent,
    totals.byModel,
  ];
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const result = queue.shift() ?? [];
          return {
            groupBy: async () => result,
            // aggregate calls don't chain .groupBy — they await the
            // "where" directly (via array/promise). Match drizzle's
            // thenable-like behavior by also awaiting on the where.
            then: (resolve: (rows: FakeRow[]) => unknown) => Promise.resolve(resolve(result)),
          };
        },
      }),
    }),
  } as unknown as Parameters<typeof contentMarginService>[0];
}

function wpWith(issueId: string | null, metadata: Record<string, unknown> = {}) {
  return {
    id: "wp-1",
    issueId,
    metadata,
  };
}

describe("contentMarginService.computeMargin", () => {
  it("returns zeros when the work product has no issueId", async () => {
    mockWp.getById.mockResolvedValue(wpWith(null, { listPriceCents: 9900 }));
    const svc = contentMarginService({} as never);
    const report = await svc.computeMargin("c1", "wp-1");
    expect(report.productionCostCents).toBe(0);
    expect(report.listPriceCents).toBe(9900);
    expect(report.marginPerUnitCents).toBe(9900);
    expect(report.costBreakdownByProvider).toEqual([]);
    expect(report.breakEvenUnits).toBeNull(); // no cost → infinite/zero units; null by contract
  });

  it("sums production cost from cost_events matching the issueId", async () => {
    mockWp.getById.mockResolvedValue(wpWith("issue-1", { listPriceCents: 9900 }));
    const svc = contentMarginService(
      makeDbStub({
        total: 1234,
        count: 8,
        byProvider: [{ key: "anthropic", total: 1234 }],
        byAgent: [{ key: "agent-writer", total: 1000 }, { key: "agent-editor", total: 234 }],
        byModel: [{ key: "claude-sonnet-4-6", total: 1234 }],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    expect(report.productionCostCents).toBe(1234);
    expect(report.costEventCount).toBe(8);
    expect(report.marginPerUnitCents).toBe(9900 - 1234);
    expect(report.costBreakdownByProvider).toHaveLength(1);
    expect(report.costBreakdownByAgent).toHaveLength(2);
  });

  it("projects gross margin across unitsTargetCount", async () => {
    mockWp.getById.mockResolvedValue(
      wpWith("issue-1", { listPriceCents: 9900, unitsTargetCount: 50 }),
    );
    const svc = contentMarginService(
      makeDbStub({
        total: 1234,
        count: 1,
        byProvider: [],
        byAgent: [],
        byModel: [],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    expect(report.unitsTargetCount).toBe(50);
    expect(report.projectedMarginCents).toBe((9900 - 1234) * 50);
  });

  it("computes break-even units (ceil of cost / listPrice)", async () => {
    mockWp.getById.mockResolvedValue(wpWith("issue-1", { listPriceCents: 900 }));
    const svc = contentMarginService(
      makeDbStub({
        total: 2700,
        count: 3,
        byProvider: [],
        byAgent: [],
        byModel: [],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    // 2700 / 900 = 3
    expect(report.breakEvenUnits).toBe(3);
  });

  it("ceils break-even when cost isn't cleanly divisible by price", async () => {
    mockWp.getById.mockResolvedValue(wpWith("issue-1", { listPriceCents: 500 }));
    const svc = contentMarginService(
      makeDbStub({
        total: 1401,
        count: 5,
        byProvider: [],
        byAgent: [],
        byModel: [],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    // 1401 / 500 = 2.802 → 3
    expect(report.breakEvenUnits).toBe(3);
  });

  it("returns nulls for margin-per-unit when listPrice is not set", async () => {
    mockWp.getById.mockResolvedValue(wpWith("issue-1", {}));
    const svc = contentMarginService(
      makeDbStub({
        total: 500,
        count: 2,
        byProvider: [],
        byAgent: [],
        byModel: [],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    expect(report.listPriceCents).toBeNull();
    expect(report.marginPerUnitCents).toBeNull();
    expect(report.projectedMarginCents).toBeNull();
    expect(report.breakEvenUnits).toBeNull();
    // Production cost still reported.
    expect(report.productionCostCents).toBe(500);
  });

  it("ignores non-integer / negative metadata values", async () => {
    mockWp.getById.mockResolvedValue(
      wpWith("issue-1", {
        listPriceCents: -1,
        unitsTargetCount: "ten" as unknown as number,
      }),
    );
    const svc = contentMarginService(
      makeDbStub({
        total: 100,
        count: 1,
        byProvider: [],
        byAgent: [],
        byModel: [],
      }),
    );
    const report = await svc.computeMargin("c1", "wp-1");
    expect(report.listPriceCents).toBeNull();
    expect(report.unitsTargetCount).toBeNull();
  });

  it("throws 404 when the work product cannot be found", async () => {
    mockWp.getById.mockResolvedValue(null);
    const svc = contentMarginService({} as never);
    await expect(svc.computeMargin("c1", "missing")).rejects.toThrow(/not found/i);
  });
});
