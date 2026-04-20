import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_COMPANY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const mockHeartbeat = vi.hoisted(() => ({
  getRun: vi.fn(),
  listEvents: vi.fn(),
}));

type LiveEvent = {
  id: number;
  companyId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
type Listener = (event: LiveEvent) => void;

const mockSubscribers = vi.hoisted(() => new Map<string, Set<(event: any) => void>>());

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeat,
  subscribeCompanyLiveEvents: (companyId: string, listener: Listener) => {
    let set = mockSubscribers.get(companyId);
    if (!set) {
      set = new Set();
      mockSubscribers.set(companyId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  },
}));

function emit(event: LiveEvent) {
  const set = mockSubscribers.get(event.companyId);
  if (!set) return;
  for (const listener of Array.from(set)) listener(event);
}

async function startApp(actor?: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const [{ errorHandler }, { runStreamRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/run-stream.js"),
  ]);
  const app = express();
  const defaultActor = {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "operator" }],
  };
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? defaultActor;
    next();
  });
  app.use("/api", runStreamRoutes({} as any));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port, address } = server.address() as AddressInfo;
  return {
    url: `http://${address}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Minimal SSE client. Parses `event:` / `id:` / `data:` lines into
 * frames and resolves when `predicate` matches a frame or when the
 * stream closes.
 */
async function readSseUntil(
  url: string,
  predicate: (frame: { event?: string; id?: string; data: string }) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<{
  frames: Array<{ event?: string; id?: string; data: string; parsed?: unknown }>;
  status: number;
  headers: http.IncomingHttpHeaders;
  req: http.ClientRequest;
}> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const status = res.statusCode ?? 0;
      const headers = res.headers;
      const frames: Array<{ event?: string; id?: string; data: string; parsed?: unknown }> = [];
      let buffer = "";
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`SSE timed out after ${timeoutMs}ms (frames so far: ${frames.length})`));
      }, timeoutMs);

      const finish = () => {
        clearTimeout(timer);
        resolve({ frames, status, headers, req });
      };

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        // SSE frames are separated by blank lines.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame: { event?: string; id?: string; data: string } = { data: "" };
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) continue; // comment / keep-alive
            if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
            else if (line.startsWith("data:")) {
              frame.data = frame.data ? `${frame.data}\n${line.slice(5).trim()}` : line.slice(5).trim();
            }
          }
          try {
            (frame as { parsed?: unknown }).parsed = JSON.parse(frame.data);
          } catch {
            // leave unparsed
          }
          frames.push(frame);
          if (predicate(frame)) {
            req.destroy();
            finish();
            return;
          }
        }
      });
      res.on("end", finish);
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on("error", reject);
  });
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (chunks += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: chunks ? JSON.parse(chunks) : null });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

describe("GET /api/heartbeat-runs/:runId/events/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribers.clear();
  });

  afterEach(() => {
    mockSubscribers.clear();
  });

  it("returns 404 when the run does not exist", async () => {
    mockHeartbeat.getRun.mockResolvedValue(null);
    const app = await startApp();
    try {
      const res = await fetchJson(`${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`);
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects cross-tenant subscribers with 403", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: OTHER_COMPANY_ID, status: "running" });
    const app = await startApp();
    try {
      const res = await fetchJson(`${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`);
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("replays historical events then closes when the run is already terminal", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY_ID, status: "completed" });
    mockHeartbeat.listEvents.mockResolvedValue([
      {
        seq: 1,
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        color: null,
        message: "hello",
        payload: null,
        createdAt: new Date().toISOString(),
      },
      {
        seq: 2,
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        color: null,
        message: "bye",
        payload: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    const app = await startApp();
    try {
      const result = await readSseUntil(
        `${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`,
        (frame) => frame.event === "end",
      );
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(result.headers["cache-control"]).toMatch(/no-cache/);
      const replayed = result.frames.filter((f) => f.event === "heartbeat.run.event");
      expect(replayed.length).toBe(2);
      const end = result.frames.find((f) => f.event === "end");
      expect(end).toBeTruthy();
      expect((end!.parsed as { status: string }).status).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("forwards live events and deduplicates against the replay window", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY_ID, status: "running" });
    mockHeartbeat.listEvents.mockResolvedValue([
      {
        seq: 5,
        eventType: "lifecycle",
        stream: null,
        level: null,
        color: null,
        message: "caught-up",
        payload: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    const app = await startApp();
    try {
      const pending = readSseUntil(
        `${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream?afterSeq=4`,
        (frame) =>
          frame.event === "heartbeat.run.event" && (frame.parsed as any)?.seq === 7,
      );

      // Let the stream open and the replay flush.
      await new Promise((r) => setTimeout(r, 50));

      // Emit a seq=5 duplicate that should be filtered out.
      emit({
        id: 1001,
        companyId: COMPANY_ID,
        type: "heartbeat.run.event",
        createdAt: new Date().toISOString(),
        payload: { runId: RUN_ID, seq: 5, eventType: "lifecycle", message: "dup" },
      });
      // Emit a new live event at seq=7.
      emit({
        id: 1002,
        companyId: COMPANY_ID,
        type: "heartbeat.run.event",
        createdAt: new Date().toISOString(),
        payload: { runId: RUN_ID, seq: 7, eventType: "lifecycle", message: "live" },
      });

      const result = await pending;
      const eventFrames = result.frames.filter((f) => f.event === "heartbeat.run.event");
      // Exactly 2: the catch-up seq=5 and the live seq=7. The duplicate
      // seq=5 emitted over the bus must have been filtered out.
      expect(eventFrames.length).toBe(2);
      expect((eventFrames[0]!.parsed as any).seq).toBe(5);
      expect((eventFrames[1]!.parsed as any).seq).toBe(7);
    } finally {
      await app.close();
    }
  });

  it("ignores events for other runs on the same company bus", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY_ID, status: "running" });
    mockHeartbeat.listEvents.mockResolvedValue([]);
    const app = await startApp();
    try {
      const pending = readSseUntil(
        `${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`,
        (frame) =>
          frame.event === "heartbeat.run.event" && (frame.parsed as any)?.seq === 42,
      );
      await new Promise((r) => setTimeout(r, 30));
      // Wrong runId; must be skipped.
      emit({
        id: 2001,
        companyId: COMPANY_ID,
        type: "heartbeat.run.event",
        createdAt: new Date().toISOString(),
        payload: { runId: "some-other-run", seq: 99, eventType: "lifecycle" },
      });
      // Correct runId; must be forwarded.
      emit({
        id: 2002,
        companyId: COMPANY_ID,
        type: "heartbeat.run.event",
        createdAt: new Date().toISOString(),
        payload: { runId: RUN_ID, seq: 42, eventType: "lifecycle" },
      });
      const result = await pending;
      const forwarded = result.frames.filter((f) => f.event === "heartbeat.run.event");
      expect(forwarded.length).toBe(1);
      expect((forwarded[0]!.parsed as any).seq).toBe(42);
    } finally {
      await app.close();
    }
  });

  it("closes the stream when a terminal status event arrives", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY_ID, status: "running" });
    mockHeartbeat.listEvents.mockResolvedValue([]);
    const app = await startApp();
    try {
      const pending = readSseUntil(
        `${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`,
        (frame) => frame.event === "end",
      );
      await new Promise((r) => setTimeout(r, 30));
      emit({
        id: 3001,
        companyId: COMPANY_ID,
        type: "heartbeat.run.status",
        createdAt: new Date().toISOString(),
        payload: { runId: RUN_ID, status: "failed" },
      });
      const result = await pending;
      const endFrame = result.frames.find((f) => f.event === "end");
      expect(endFrame).toBeTruthy();
      expect((endFrame!.parsed as any).status).toBe("failed");
    } finally {
      await app.close();
    }
  });

  it("unsubscribes from the bus when the client disconnects", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY_ID, status: "running" });
    mockHeartbeat.listEvents.mockResolvedValue([]);
    const app = await startApp();
    try {
      const result = await readSseUntil(
        `${app.url}/api/heartbeat-runs/${RUN_ID}/events/stream`,
        // Closing after the first frame — in this case, nothing arrives
        // so we resolve off the timeout-guarded stream-open comment by
        // forcing a predicate that matches the first keep-alive-style
        // frame. We just let the connection establish then abort.
        (_frame) => false,
        { timeoutMs: 150 },
      ).catch(() => null);
      // Connection aborted by the timeout; that triggers req `close`.
      // Give the server's teardown a tick to run.
      await new Promise((r) => setTimeout(r, 50));
      const set = mockSubscribers.get(COMPANY_ID);
      expect(set?.size ?? 0).toBe(0);
      void result;
    } finally {
      await app.close();
    }
  });
});
