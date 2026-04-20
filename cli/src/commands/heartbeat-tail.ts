import pc from "picocolors";
import { resolveCommandContext, type BaseClientOptions } from "./client/common.js";

interface TailOptions extends BaseClientOptions {
  runId: string;
  fromSeq?: string;
  eventType?: string;
  json?: boolean;
  once?: boolean;
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

interface HeartbeatEventPayload {
  runId: string;
  seq?: number;
  eventType?: string;
  stream?: string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
}

interface StatusEventPayload {
  runId: string;
  status: string;
}

/**
 * Parse an SSE stream on the fly. Yields frames as they arrive; the
 * caller decides when to stop reading. Event boundaries are blank
 * lines; within a frame, `data:` / `event:` / `id:` lines accumulate
 * into one frame.
 */
async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame: SseFrame = { data: "" };
        for (const line of raw.split("\n")) {
          if (line.startsWith(":")) continue; // comment / keep-alive
          if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("data:")) {
            frame.data = frame.data ? `${frame.data}\n${line.slice(5).trim()}` : line.slice(5).trim();
          }
        }
        yield frame;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function fmtTime(raw: string | null | undefined): string {
  if (!raw) return pc.dim("--:--:--");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return pc.dim("--:--:--");
  return pc.dim(d.toTimeString().slice(0, 8));
}

function fmtLevel(level: string | null | undefined): string {
  switch (level) {
    case "error":
      return pc.red(pc.bold("error"));
    case "warn":
      return pc.yellow("warn ");
    case "debug":
      return pc.dim("debug");
    case "info":
    default:
      return pc.cyan("info ");
  }
}

function fmtEventType(type: string | null | undefined): string {
  if (!type) return pc.dim("event");
  if (type === "lifecycle") return pc.green("lifecycle     ");
  if (type === "adapter.invoke") return pc.blue("adapter.invoke");
  if (type === "error") return pc.red("error         ");
  if (type === "context_pack.hydrated") return pc.magenta("ctx.hydrated  ");
  return type.padEnd(14);
}

function fmtSeq(seq: number | undefined): string {
  if (typeof seq !== "number") return pc.dim("----");
  return pc.dim(String(seq).padStart(4));
}

function renderEventFrame(parsed: HeartbeatEventPayload): string {
  const parts = [
    fmtTime(parsed.createdAt),
    fmtSeq(parsed.seq),
    fmtLevel(parsed.level),
    fmtEventType(parsed.eventType),
    parsed.message ?? "",
  ];
  const line = parts.join(" ");
  if (parsed.stream === "stderr") return pc.red(line);
  return line;
}

function renderStatusFrame(parsed: StatusEventPayload): string {
  return `${pc.dim(new Date().toTimeString().slice(0, 8))} ${pc.magenta("status       ")} ${pc.bold(parsed.status)}`;
}

export async function tailHeartbeatRun(options: TailOptions): Promise<void> {
  const ctx = resolveCommandContext(options);
  const apiBase = ctx.api.apiBase;
  const fromSeq = Number(options.fromSeq ?? 0);
  const qs = new URLSearchParams();
  if (Number.isFinite(fromSeq) && fromSeq > 0) qs.set("afterSeq", String(fromSeq));
  const url = `${apiBase}/api/heartbeat-runs/${encodeURIComponent(options.runId)}/events/stream${
    qs.toString() ? `?${qs.toString()}` : ""
  }`;

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const apiKey = (options.apiKey ?? process.env.PAPERCLIP_API_KEY ?? "").trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  if (!options.json) {
    process.stdout.write(
      `${pc.dim("tailing")} ${pc.bold(options.runId)} ${pc.dim(`via ${apiBase}`)}\n`,
    );
  }

  const res = await fetch(url, { headers });
  if (res.status === 404) {
    process.stderr.write(pc.red(`Run ${options.runId} not found on ${apiBase}\n`));
    process.exitCode = 1;
    return;
  }
  if (res.status === 401 || res.status === 403) {
    process.stderr.write(
      pc.red(
        `Not authorized (${res.status}). Pass --api-key, set PAPERCLIP_API_KEY, or run \`paperclipai auth board\`.\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    process.stderr.write(pc.red(`HTTP ${res.status}: ${body}\n`));
    process.exitCode = 1;
    return;
  }
  if (!res.body) {
    process.stderr.write(pc.red("Server returned no response body\n"));
    process.exitCode = 1;
    return;
  }

  const filterEventType = options.eventType?.trim();
  let endSeen = false;

  // Install a SIGINT handler so ctrl-C gives a clean exit rather than
  // leaving the process in a weird half-connected state.
  const abort = new AbortController();
  const onSigint = () => {
    abort.abort();
    if (!options.json) process.stdout.write(pc.dim("\n^C — disconnecting\n"));
  };
  process.once("SIGINT", onSigint);

  try {
    for await (const frame of readSseFrames(res.body)) {
      if (abort.signal.aborted) break;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        parsed = frame.data;
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ event: frame.event ?? "message", id: frame.id, data: parsed })}\n`,
        );
      } else if (frame.event === "heartbeat.run.event") {
        const payload = parsed as HeartbeatEventPayload;
        if (filterEventType && payload.eventType !== filterEventType) continue;
        process.stdout.write(`${renderEventFrame(payload)}\n`);
      } else if (frame.event === "heartbeat.run.status") {
        process.stdout.write(`${renderStatusFrame(parsed as StatusEventPayload)}\n`);
      } else if (frame.event === "end") {
        const payload = parsed as { status?: string; reason?: string };
        process.stdout.write(
          `${pc.dim(new Date().toTimeString().slice(0, 8))} ${pc.bold(
            pc.green(`run ended: ${payload.status ?? "unknown"}`),
          )}${payload.reason ? pc.dim(` (${payload.reason})`) : ""}\n`,
        );
        endSeen = true;
      } else if (frame.event === "error") {
        const payload = parsed as { message?: string; detail?: string };
        process.stderr.write(
          pc.red(
            `stream error: ${payload.message ?? "unknown"}${
              payload.detail ? ` — ${payload.detail}` : ""
            }\n`,
          ),
        );
      }

      if (endSeen && options.once === false) {
        // If `--no-once` is passed we stay connected so operators can
        // watch a run restart. Default is to exit on terminal.
        continue;
      }
      if (endSeen) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (!endSeen && !abort.signal.aborted) {
    process.stderr.write(pc.yellow("stream closed unexpectedly (no terminal event observed)\n"));
    process.exitCode = 2;
  }
}
