/**
 * The only place the agent writes to the SSE stream. Everything else calls emitX().
 *
 * Each event is `.parse()`d against the contract first, so a malformed one throws here
 * instead of reaching the UI — notably a failed trace step with no error message.
 */
import type { Response } from 'express';
import {
  DoneEvent,
  SourcesEvent,
  StreamErrorEvent,
  TokenEvent,
  TraceEvent,
  type Source,
  type ToolName
} from '@lumina/contract';

/** Four headers and a flush. Never mount compression() on this route — it buffers (§11.2). */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export class SseEmitter {
  private step = 0;
  private closed = false;
  private firstTokenAt: number | null = null;

  constructor(
    private readonly res: Response,
    private readonly startedAt: number
  ) {}

  /** ms from request start to the first token. Null until one is sent. */
  get ttftMs(): number | null {
    return this.firstTokenAt === null ? null : this.firstTokenAt - this.startedAt;
  }

  /** 1-based, monotonic across the whole request. */
  nextStep(): number {
    return ++this.step;
  }

  get stepsEmitted(): number {
    return this.step;
  }

  // `subQuestion` is seam 4 (§13): always undefined in Week 1, a real index in Week 2.
  emitTrace(ev: {
    step: number;
    tool: ToolName;
    input: Record<string, unknown>;
    ok: boolean;
    ms: number;
    reason?: string;
    error?: string;
    subQuestion?: number;
  }): void {
    this.write('trace', TraceEvent.parse(ev));
  }

  emitSources(sources: Source[]): void {
    this.write('sources', SourcesEvent.parse(sources));
  }

  emitToken(text: string): void {
    if (!text) return;
    if (this.firstTokenAt === null) this.firstTokenAt = Date.now();
    this.write('token', TokenEvent.parse({ text }));
  }

  emitDone(done: unknown): void {
    this.write('done', DoneEvent.parse(done));
  }

  /** Once bytes are on the wire the status is already 200, so this event IS the error
   *  report (§9 rule 3). No `done` follows it. */
  emitError(status: number, error: string): void {
    this.write('error', StreamErrorEvent.parse({ status, error }));
  }

  /** Client hung up. Stop writing; the run log is still written in the caller's finally. */
  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  end(): void {
    if (!this.closed) this.res.end();
    this.closed = true;
  }

  private write(event: string, data: unknown): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flushable = this.res as Response & { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  }
}
