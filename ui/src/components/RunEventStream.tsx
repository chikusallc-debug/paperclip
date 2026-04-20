/**
 * RunEventStream
 *
 * Board-facing live tail of /api/heartbeat-runs/:runId/events/stream
 * (the M3a SSE endpoint). Renders structured heartbeat run events in
 * a terminal-like monospace column so operators can watch a chapter
 * / course section being produced in real time.
 *
 * This component uses `fetch` with a ReadableStream reader (not the
 * native EventSource) because EventSource can't set custom auth
 * headers, and we rely on the existing cookie session via
 * `credentials: "include"` — the same mechanism the rest of the UI
 * uses.
 *
 * NOTE: This code was authored without an interactive browser
 * available. The TypeScript compiles cleanly and the logic mirrors
 * the CLI tail (which IS tested), but the visual layout should be
 * verified by running `pnpm dev:ui` and eyeballing the frames.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface RunEventStreamProps {
  runId: string;
  /**
   * If true, starts streaming immediately on mount. When false the
   * panel renders the connect button and waits for a click.
   */
  autoConnect?: boolean;
  /** Cap on frames kept in memory. Oldest drops off first. */
  maxBufferedFrames?: number;
  className?: string;
}

interface ParsedFrame {
  id?: string;
  event?: string;
  rawData: string;
  parsed?: unknown;
}

interface HeartbeatEventPayload {
  runId: string;
  seq?: number;
  eventType?: string;
  stream?: string | null;
  level?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
}

interface StatusPayload {
  runId: string;
  status: string;
}

interface DisplayRow {
  key: string;
  kind: "event" | "status" | "end" | "error" | "info";
  time: string;
  seq?: number;
  eventType?: string;
  level?: string;
  message?: string;
  raw?: unknown;
}

function classForKind(kind: DisplayRow["kind"], level?: string): string {
  if (kind === "error") return "text-red-500";
  if (kind === "end") return "text-emerald-500 font-semibold";
  if (kind === "status") return "text-violet-500";
  if (level === "error") return "text-red-500";
  if (level === "warn") return "text-amber-500";
  if (level === "debug") return "text-slate-400";
  return "text-slate-800 dark:text-slate-200";
}

function classForEventType(type?: string): string {
  if (!type) return "text-slate-400";
  if (type === "lifecycle") return "text-emerald-600 dark:text-emerald-400";
  if (type === "adapter.invoke") return "text-blue-600 dark:text-blue-400";
  if (type === "error") return "text-red-500";
  if (type === "context_pack.hydrated") return "text-fuchsia-500";
  return "text-slate-500";
}

function hhmmss(iso?: string | null): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedFrame> {
  const reader = body.getReader();
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
        const frame: ParsedFrame = { rawData: "" };
        for (const line of raw.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("data:")) {
            frame.rawData = frame.rawData
              ? `${frame.rawData}\n${line.slice(5).trim()}`
              : line.slice(5).trim();
          }
        }
        try {
          frame.parsed = JSON.parse(frame.rawData);
        } catch {
          // leave unparsed
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

export function RunEventStream({
  runId,
  autoConnect = true,
  maxBufferedFrames = 500,
  className,
}: RunEventStreamProps) {
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "streaming" | "ended" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const maxSeqRef = useRef<number>(0);

  const addRow = useCallback(
    (row: DisplayRow) => {
      setRows((prev) => {
        const next = [...prev, row];
        if (next.length > maxBufferedFrames) {
          return next.slice(next.length - maxBufferedFrames);
        }
        return next;
      });
    },
    [maxBufferedFrames],
  );

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    if (!runId || status === "connecting" || status === "streaming") return;
    setErrorMessage(null);
    setStatus("connecting");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const afterSeq = maxSeqRef.current;
    const qs = afterSeq > 0 ? `?afterSeq=${afterSeq}` : "";

    let res: Response;
    try {
      res = await fetch(
        `/api/heartbeat-runs/${encodeURIComponent(runId)}/events/stream${qs}`,
        {
          headers: { Accept: "text/event-stream" },
          credentials: "include",
          signal: ctrl.signal,
        },
      );
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!res.ok || !res.body) {
      setStatus("error");
      setErrorMessage(`HTTP ${res.status}`);
      return;
    }
    setStatus("streaming");
    try {
      for await (const frame of readFrames(res.body)) {
        if (ctrl.signal.aborted) break;
        if (frame.event === "heartbeat.run.event") {
          const payload = (frame.parsed as HeartbeatEventPayload | undefined) ?? { runId };
          if (typeof payload.seq === "number" && payload.seq > maxSeqRef.current) {
            maxSeqRef.current = payload.seq;
          }
          addRow({
            key: `evt-${frame.id ?? Math.random()}-${payload.seq ?? ""}`,
            kind: "event",
            time: hhmmss(payload.createdAt ?? new Date().toISOString()),
            seq: payload.seq,
            eventType: payload.eventType,
            level: payload.level ?? undefined,
            message: payload.message ?? "",
            raw: payload.payload,
          });
        } else if (frame.event === "heartbeat.run.status") {
          const payload = frame.parsed as StatusPayload | undefined;
          addRow({
            key: `status-${Math.random()}`,
            kind: "status",
            time: hhmmss(new Date().toISOString()),
            message: `→ ${payload?.status ?? "?"}`,
          });
        } else if (frame.event === "end") {
          const payload = frame.parsed as { status?: string; reason?: string } | undefined;
          addRow({
            key: `end-${Math.random()}`,
            kind: "end",
            time: hhmmss(new Date().toISOString()),
            message: `run ended: ${payload?.status ?? "?"}${payload?.reason ? ` (${payload.reason})` : ""}`,
          });
          setStatus("ended");
        } else if (frame.event === "error") {
          const payload = frame.parsed as { message?: string; detail?: string } | undefined;
          addRow({
            key: `err-${Math.random()}`,
            kind: "error",
            time: hhmmss(new Date().toISOString()),
            message: `stream error: ${payload?.message ?? "unknown"}`,
          });
          setStatus("error");
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      if (status !== "ended" && !ctrl.signal.aborted) {
        setStatus((prev) => (prev === "streaming" ? "idle" : prev));
      }
    }
  }, [addRow, runId, status]);

  useEffect(() => {
    if (autoConnect) void connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case "connecting":
        return "connecting…";
      case "streaming":
        return "live";
      case "ended":
        return "ended";
      case "error":
        return errorMessage ? `error: ${errorMessage}` : "error";
      default:
        return "idle";
    }
  }, [status, errorMessage]);

  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-slate-500">run</span>
        <span className="font-mono truncate">{runId}</span>
        <span className="text-slate-400">·</span>
        <span
          className={
            status === "streaming"
              ? "text-emerald-600"
              : status === "ended"
                ? "text-slate-500"
                : status === "error"
                  ? "text-red-500"
                  : "text-slate-500"
          }
        >
          {statusLabel}
        </span>
        <div className="ml-auto flex gap-2">
          {status === "streaming" ? (
            <button
              type="button"
              onClick={disconnect}
              className="px-2 py-0.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void connect()}
              className="px-2 py-0.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {status === "ended" || status === "error" ? "reconnect" : "connect"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setRows([])}
            className="px-2 py-0.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            clear
          </button>
        </div>
      </div>
      <div className="font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-2 max-h-[400px] overflow-y-auto">
        {rows.length === 0 ? (
          <div className="text-slate-400 italic">no events yet…</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              className={`flex items-start gap-2 whitespace-pre-wrap break-words ${classForKind(
                row.kind,
                row.level,
              )}`}
            >
              <span className="text-slate-400 shrink-0 tabular-nums">{row.time}</span>
              <span className="text-slate-400 shrink-0 tabular-nums w-10 text-right">
                {row.seq ?? ""}
              </span>
              <span className={`${classForEventType(row.eventType)} shrink-0 w-32`}>
                {row.eventType ??
                  (row.kind === "status" ? "status" : row.kind === "end" ? "end" : "")}
              </span>
              <span className="flex-1">{row.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
