import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";
import { heartbeatService, subscribeCompanyLiveEvents } from "../services/index.js";
import { redactEventPayload } from "../redaction.js";

/**
 * SSE keep-alive interval. Must be shorter than typical reverse-proxy
 * idle timeouts (Nginx default 60s, Cloudflare 100s) so connections
 * stay open through a full heartbeat run.
 */
const SSE_KEEPALIVE_MS = 25_000;

/**
 * Hard cap on replay events in a single catch-up. Keeps a
 * long-running streaming connect from blocking the event loop on a
 * huge run history.
 */
const REPLAY_BATCH_LIMIT = 500;

/**
 * Run statuses that indicate the run is finished. When we observe a
 * heartbeat.run.status event for the tailed run matching one of
 * these, we emit a final `end` event and close the SSE connection.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

interface SseFrame {
  id?: string | number;
  event?: string;
  data: unknown;
}

function writeSseFrame(res: Response, frame: SseFrame): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event) lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  lines.push("", "");
  return res.write(lines.join("\n"));
}

function writeKeepAlive(res: Response): boolean {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(": keep-alive\n\n");
}

function startSseHeaders(req: Request, res: Response): void {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable Nginx response buffering
  });
  // Flush headers so the client sees the stream has opened even if
  // no events arrive for a while.
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as Response & { flushHeaders: () => void }).flushHeaders();
  }
  // Some proxies only start streaming after a first byte; emit a
  // comment to signal the stream is alive.
  res.write(": stream-open\n\n");

  // Prevent Node from buffering up responses at the other direction
  // too (request body), and react promptly to disconnect.
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
}

/**
 * SSE tail of structured heartbeat-run events.
 *
 *   GET /api/heartbeat-runs/:runId/events/stream?afterSeq=N
 *
 * - Replays DB-persisted events after `afterSeq` (if provided) as a
 *   catch-up batch, so reconnecting clients can resume without loss.
 * - Subscribes to the in-process live-events bus and forwards
 *   `heartbeat.run.event` frames for this run.
 * - Also forwards `heartbeat.run.status` frames so callers can observe
 *   state transitions.
 * - Closes the connection cleanly when the run reaches a terminal
 *   status (completed/failed/cancelled/timed_out).
 * - Sends a keep-alive comment every 25 seconds to outlive typical
 *   reverse-proxy idle timeouts.
 */
export function runStreamRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);

  router.get("/heartbeat-runs/:runId/events/stream", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    startSseHeaders(req, res);

    // --- 1. Catch-up from afterSeq, if requested ---
    const afterSeqRaw = Number(req.query.afterSeq ?? 0);
    const afterSeq = Number.isFinite(afterSeqRaw) && afterSeqRaw > 0 ? afterSeqRaw : 0;
    let lastDeliveredSeq = afterSeq;

    try {
      const historical = await heartbeat.listEvents(runId, afterSeq, REPLAY_BATCH_LIMIT);
      for (const event of historical) {
        writeSseFrame(res, {
          id: event.seq,
          event: "heartbeat.run.event",
          data: {
            runId,
            seq: event.seq,
            eventType: event.eventType,
            stream: event.stream ?? null,
            level: event.level ?? null,
            color: event.color ?? null,
            message: event.message ?? null,
            payload: redactEventPayload(event.payload),
            createdAt: event.createdAt,
          },
        });
        if (typeof event.seq === "number" && event.seq > lastDeliveredSeq) {
          lastDeliveredSeq = event.seq;
        }
      }
      // If the run is already terminal, close after replay — a late
      // client just wants the final log, not a dangling connection.
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        writeSseFrame(res, {
          event: "end",
          data: { runId, status: run.status, reason: "terminal_at_connect" },
        });
        res.end();
        return;
      }
    } catch (err) {
      // Surface the error as an SSE frame rather than 500-ing the
      // response — the connection is already upgraded.
      writeSseFrame(res, {
        event: "error",
        data: {
          message: "catch-up replay failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      });
      res.end();
      return;
    }

    // --- 2. Live subscription ---
    let closed = false;
    const deliveredSeqs = new Set<number>();

    const unsubscribe = subscribeCompanyLiveEvents(run.companyId, (event: LiveEvent) => {
      if (closed) return;
      if (event.type === "heartbeat.run.event") {
        const payload = event.payload as { runId?: string; seq?: number } | undefined;
        if (!payload || payload.runId !== runId) return;
        const seq = typeof payload.seq === "number" ? payload.seq : null;
        // De-dup across catch-up boundary: if the historical replay
        // already delivered this seq we skip.
        if (seq !== null) {
          if (seq <= lastDeliveredSeq) return;
          if (deliveredSeqs.has(seq)) return;
          deliveredSeqs.add(seq);
          lastDeliveredSeq = seq;
        }
        writeSseFrame(res, {
          id: seq ?? undefined,
          event: "heartbeat.run.event",
          data: { ...payload, runId },
        });
        return;
      }
      if (event.type === "heartbeat.run.status") {
        const payload = event.payload as { runId?: string; status?: string } | undefined;
        if (!payload || payload.runId !== runId) return;
        writeSseFrame(res, {
          event: "heartbeat.run.status",
          data: { ...payload, runId },
        });
        if (payload.status && TERMINAL_RUN_STATUSES.has(payload.status)) {
          writeSseFrame(res, {
            event: "end",
            data: { runId, status: payload.status, reason: "terminal" },
          });
          teardown();
        }
      }
    });

    const keepAlive = setInterval(() => {
      if (!writeKeepAlive(res)) teardown();
    }, SSE_KEEPALIVE_MS);

    function teardown() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      try {
        unsubscribe();
      } catch {
        // best-effort
      }
      if (!res.writableEnded) {
        res.end();
      }
    }

    req.on("close", teardown);
    req.on("end", teardown);
    res.on("close", teardown);
    res.on("error", teardown);
  });

  return router;
}
