import { terminal } from './case.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeEventSub } from './eventsub.ts';
import { normalize } from './ingest.ts';
import type { VoteLoop } from './loop.ts';

export async function replay(loop: VoteLoop, options: {
  now?: () => number; sleep?: (ms: number) => Promise<void>; runId?: string; signal?: AbortSignal;
} = {}): Promise<void> {
  if (loop.replaying || loop.engine.list().some(c => !terminal(c.state))) throw new Error('An active case must close before replay');
  loop.replaying = true; loop.publish();
  const now = options.now ?? loop.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, { signal: options.signal }));
  const start = now(); const run = options.runId ?? randomUUID();
  let first: number | undefined;
  try {
    await new FakeEventSub(new URL('../fixtures/chat.jsonl', import.meta.url)).start(async raw => {
      if (options.signal?.aborted) return;
      const event = normalize(raw);
      if (!event) throw new Error('Invalid fixture event');
      first ??= event.at;
      const due = start + event.at - first;
      await sleep(Math.max(0, due - now()));
      if (options.signal?.aborted) return;
      const value = structuredClone(raw) as any;
      value.metadata.message_timestamp = new Date(due).toISOString();
      value.metadata.message_id = `${run}/${event.eventId}`;
      value.payload.event.message_id = `${run}/${event.messageId}`;
      if (value.payload.event.reply) value.payload.event.reply.parent_message_id = `${run}/${event.replyTo}`;
      loop.accept(value);
    }, options.signal);
  } finally { loop.replaying = false; loop.publish(); }
}
