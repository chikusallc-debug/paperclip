import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, publishAttempts } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { serverVersion } from "../version.js";
import { assertBoard } from "./authz.js";

/**
 * Prometheus text exposition (v0.0.4) for Paperclip. Narrow and
 * opinionated: exposes the metrics an operator running a content
 * factory actually wants on a Grafana dashboard — run counts by
 * status, publish attempts by status, and process-level memory.
 * Additional metrics can be added here without any client-side
 * changes since the endpoint is a single string.
 *
 * Access: board-only by default. Agents and anonymous clients are
 * rejected (403/401) so the metrics surface does not leak run
 * volumes to attackers. Operators running a metrics scraper
 * unauthenticated should put the route behind a reverse-proxy
 * allow-list or disable it via PAPERCLIP_METRICS_DISABLED=true.
 */

interface MetricLine {
  name: string;
  help: string;
  type: "counter" | "gauge";
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const inner = entries
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `{${inner}}`;
}

export function renderPrometheusText(metrics: MetricLine[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      lines.push(`${metric.name}${renderLabels(sample.labels)} ${sample.value}`);
    }
  }
  // Prometheus requires a trailing newline.
  return `${lines.join("\n")}\n`;
}

async function collectHeartbeatRunMetrics(db: Db): Promise<MetricLine> {
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .groupBy(heartbeatRuns.status);
  return {
    name: "paperclip_heartbeat_runs_total",
    help: "Total heartbeat runs observed, grouped by status.",
    type: "counter",
    samples: rows.map((r) => ({
      labels: { status: r.status },
      value: Number(r.count ?? 0),
    })),
  };
}

async function collectActiveHeartbeatGauge(db: Db): Promise<MetricLine> {
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(sql`${heartbeatRuns.status} IN ('queued', 'running')`)
    .groupBy(heartbeatRuns.status);
  const byStatus = new Map<string, number>();
  for (const row of rows) byStatus.set(row.status, Number(row.count ?? 0));
  return {
    name: "paperclip_heartbeat_runs_active",
    help: "Heartbeat runs currently queued or running.",
    type: "gauge",
    samples: [
      { labels: { status: "queued" }, value: byStatus.get("queued") ?? 0 },
      { labels: { status: "running" }, value: byStatus.get("running") ?? 0 },
    ],
  };
}

async function collectPublishAttemptMetrics(db: Db): Promise<MetricLine> {
  const rows = await db
    .select({
      status: publishAttempts.status,
      count: sql<number>`count(*)::int`,
    })
    .from(publishAttempts)
    .groupBy(publishAttempts.status);
  return {
    name: "paperclip_publish_attempts_total",
    help: "Total publish attempts recorded, grouped by final status.",
    type: "counter",
    samples: rows.map((r) => ({
      labels: { status: r.status },
      value: Number(r.count ?? 0),
    })),
  };
}

function collectProcessMemoryMetrics(): MetricLine[] {
  const m = process.memoryUsage();
  return [
    {
      name: "paperclip_process_resident_memory_bytes",
      help: "Resident set size of the Paperclip server process.",
      type: "gauge",
      samples: [{ labels: {}, value: m.rss }],
    },
    {
      name: "paperclip_process_heap_used_bytes",
      help: "V8 heap used by the Paperclip server process.",
      type: "gauge",
      samples: [{ labels: {}, value: m.heapUsed }],
    },
  ];
}

function collectProcessInfoMetric(): MetricLine {
  return {
    name: "paperclip_build_info",
    help: "Static build info. Value is always 1; labels carry the version.",
    type: "gauge",
    samples: [{ labels: { version: serverVersion }, value: 1 }],
  };
}

/**
 * Safe-by-default metrics route. The disable toggle is the env var
 * PAPERCLIP_METRICS_DISABLED; the board-auth guard is the active
 * enforcement point for in-transit requests.
 */
export function metricsRoutes(db?: Db) {
  const router = Router();
  const disabled = process.env.PAPERCLIP_METRICS_DISABLED === "true";

  router.get("/", async (req, res) => {
    if (disabled) {
      res.status(404).type("text/plain").send("metrics disabled\n");
      return;
    }
    assertBoard(req);

    try {
      const metrics: MetricLine[] = [];
      if (db) {
        metrics.push(await collectHeartbeatRunMetrics(db));
        metrics.push(await collectActiveHeartbeatGauge(db));
        metrics.push(await collectPublishAttemptMetrics(db));
      }
      metrics.push(...collectProcessMemoryMetrics());
      metrics.push(collectProcessInfoMetric());

      res.status(200);
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.set("Cache-Control", "no-store");
      res.send(renderPrometheusText(metrics));
    } catch (err) {
      logger.warn({ err }, "metrics collection failed");
      res
        .status(503)
        .type("text/plain")
        .send(`# metrics collection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });

  return router;
}
