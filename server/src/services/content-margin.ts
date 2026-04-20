import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import { and, eq, sum, sql } from "drizzle-orm";
import { notFound } from "../errors.js";
import { contentWorkProductService } from "./content-work-products.js";

/**
 * Content-factory margin tracking (the course-factory slice of M6).
 *
 * A content work product's production cost is the sum of cost_events
 * that share its issueId. Revenue is operator-supplied via
 * `metadata.listPriceCents` (US cents; integer math keeps rounding
 * predictable). Optional `metadata.unitsTargetCount` lets operators
 * see projected gross margin at their target sales volume.
 *
 * All figures are inclusive of cached and uncached tokens (cost_events
 * already collapses those into a single costCents). Returning
 * breakdown-by-dimension (agent, provider, model) lets the UI show
 * "where did the money go" without a second query.
 */

export interface MarginBreakdownRow {
  key: string;
  label: string;
  costCents: number;
}

export interface MarginReport {
  workProductId: string;
  issueId: string | null;
  listPriceCents: number | null;
  unitsTargetCount: number | null;
  productionCostCents: number;
  /** listPrice - productionCost; null when listPrice is not set. */
  marginPerUnitCents: number | null;
  /** marginPerUnit * unitsTarget; null when either component missing. */
  projectedMarginCents: number | null;
  /**
   * Minimum units to sell to break even on production cost. null
   * when listPrice is 0 or unset.
   */
  breakEvenUnits: number | null;
  costBreakdownByProvider: MarginBreakdownRow[];
  costBreakdownByAgent: MarginBreakdownRow[];
  costBreakdownByModel: MarginBreakdownRow[];
  /** Number of cost_events summed into productionCostCents. */
  costEventCount: number;
  computedAt: Date;
}

function readIntegerMeta(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

export function contentMarginService(db: Db) {
  const workProducts = contentWorkProductService(db);

  async function sumBreakdown(
    companyId: string,
    issueId: string,
    dimension: "provider" | "agent" | "model",
  ): Promise<MarginBreakdownRow[]> {
    const dimCol =
      dimension === "provider"
        ? costEvents.provider
        : dimension === "agent"
          ? costEvents.agentId
          : costEvents.model;
    const rows = await db
      .select({
        key: dimCol,
        total: sum(costEvents.costCents).as("total"),
      })
      .from(costEvents)
      .where(
        and(eq(costEvents.companyId, companyId), eq(costEvents.issueId, issueId)),
      )
      .groupBy(dimCol);
    return rows.map((r) => ({
      key: String(r.key ?? "unknown"),
      label: String(r.key ?? "unknown"),
      costCents: Number(r.total ?? 0),
    }));
  }

  return {
    /**
     * Compute the margin report for a single content work product.
     * Never mutates. Returns zeros for all cost fields when the work
     * product has no issueId (production cost is unattributable in
     * that case).
     */
    async computeMargin(companyId: string, workProductId: string): Promise<MarginReport> {
      const wp = await workProducts.getById(companyId, workProductId);
      if (!wp) throw notFound("Content work product not found");

      const listPriceCents = readIntegerMeta(wp.metadata, "listPriceCents");
      const unitsTargetCount = readIntegerMeta(wp.metadata, "unitsTargetCount");

      if (!wp.issueId) {
        return {
          workProductId: wp.id,
          issueId: null,
          listPriceCents,
          unitsTargetCount,
          productionCostCents: 0,
          marginPerUnitCents: listPriceCents,
          projectedMarginCents:
            listPriceCents !== null && unitsTargetCount !== null
              ? listPriceCents * unitsTargetCount
              : null,
          breakEvenUnits: null,
          costBreakdownByProvider: [],
          costBreakdownByAgent: [],
          costBreakdownByModel: [],
          costEventCount: 0,
          computedAt: new Date(),
        };
      }

      const [totalRow] = await db
        .select({
          total: sum(costEvents.costCents).as("total"),
          count: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(
          and(eq(costEvents.companyId, companyId), eq(costEvents.issueId, wp.issueId)),
        );

      const productionCostCents = Number(totalRow?.total ?? 0);
      const costEventCount = Number(totalRow?.count ?? 0);

      const [byProvider, byAgent, byModel] = await Promise.all([
        sumBreakdown(companyId, wp.issueId, "provider"),
        sumBreakdown(companyId, wp.issueId, "agent"),
        sumBreakdown(companyId, wp.issueId, "model"),
      ]);

      const marginPerUnitCents =
        listPriceCents === null ? null : listPriceCents - productionCostCents;
      const projectedMarginCents =
        marginPerUnitCents !== null && unitsTargetCount !== null
          ? marginPerUnitCents * unitsTargetCount
          : null;
      const breakEvenUnits =
        listPriceCents !== null && listPriceCents > 0
          ? Math.ceil(productionCostCents / listPriceCents)
          : null;

      return {
        workProductId: wp.id,
        issueId: wp.issueId,
        listPriceCents,
        unitsTargetCount,
        productionCostCents,
        marginPerUnitCents,
        projectedMarginCents,
        breakEvenUnits,
        costBreakdownByProvider: byProvider,
        costBreakdownByAgent: byAgent,
        costBreakdownByModel: byModel,
        costEventCount,
        computedAt: new Date(),
      };
    },
  };
}

export type ContentMarginService = ReturnType<typeof contentMarginService>;
