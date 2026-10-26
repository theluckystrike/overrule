import { readFile } from 'node:fs/promises';
export type EventHandler = (event: unknown) => void | Promise<void>;
export interface ChatSource {
  start(handler: EventHandler, signal?: AbortSignal): Promise<void>;
  stop(): void;
}
/** Fixture transport. No credential loading or network access. */
export class FakeEventSub implements ChatSource {
  private file: string | URL;
  private stopped = false;
  constructor(file: string | URL) { this.file = file; }
  async start(handler: EventHandler, signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    const lines = (await readFile(this.file, 'utf8')).split('\n').filter(Boolean);
    for (const [index, line] of lines.entries()) {
      if (this.stopped || signal?.aborted) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new Error(`Invalid fixture line ${index + 1}`); }
      await handler(event);
    }
  }
  stop(): void { this.stopped = true; }
}
export interface LiveEventSubOptions { broadcasterId: string; userId: string }
/** Live transport is deliberately disabled until OAuth and reconnect tests exist. */
export class LiveEventSub implements ChatSource {
  async start(_handler: EventHandler, _signal?: AbortSignal): Promise<void> {
    throw new Error('OWNER-NEEDED. Live EventSub is not implemented. Use npm run sim');
  }
  stop(): void {}
}
