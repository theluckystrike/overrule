import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, Ingest } from '../src/ingest.ts';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
import { FakeEventSub } from '../src/eventsub.ts';

test('malformed envelopes are rejected', () => {
  assert.equal(normalize({}), null);
  assert.equal(normalize({ metadata: { message_type: 'session_keepalive' } }), null);
});
test('recorded fixture drives commands and duplicate delivery is harmless', async () => {
  const e = new CaseEngine(new Journal(), 'test'); const ingest = new Ingest(e, 'channel-test');
  const source = new FakeEventSub(new URL('../fixtures/chat.jsonl', import.meta.url));
  await source.start(event => { const c = normalize(event); if (c) ingest.accept(c, c.at); });
  assert.equal(e.list().length, 1);
  const c = e.list()[0];
  assert.equal(c.state, 'voting');
  assert.equal(Object.keys(c.votes).length, 3);
  e.tick(c.deadline!);
  assert.equal(e.get(c.id).jury, 'guilty');
});
test('viewers cannot open mod cases and foreign channels are ignored', () => {
  const e = new CaseEngine(new Journal(), 'test'); const ingest = new Ingest(e, 'channel-test');
  const base = { eventId: 'x', messageId: 'm', channelId: 'channel-test', userId: 'viewer', login: 'viewer', text: '!case @alt reason', at: 1000, role: 'viewer' as const };
  assert.equal(ingest.accept(base, 1000).ok, false);
  assert.equal(ingest.accept({ ...base, eventId: 'y', channelId: 'other' }, 1000).ok, false);
  assert.equal(e.list().length, 0);
});
test('report by reply and stale evidence checks', () => {
  const e = new CaseEngine(new Journal(), 'test'); const ingest = new Ingest(e, 'channel-test');
  const base = { eventId: 'x', messageId: 'target', channelId: 'channel-test', userId: 'alt', login: 'alt', text: 'test message', at: 1000, role: 'viewer' as const };
  assert.equal(ingest.accept(base, 1000).ok, true);
  const report = { ...base, eventId: 'report', messageId: 'report-message', userId: 'reporter', login: 'reporter', text: '!report Spam', replyTo: 'target', at: 1001 };
  assert.equal(ingest.accept(report, 1001).ok, true);
  assert.equal(e.list().length, 0); ingest.promote(ingest.queue(1001)[0].id, 1001); assert.equal(e.list()[0].message.id, 'target');
  assert.equal(ingest.accept({ ...report, eventId: 'stale', at: 1000 }, 121001).ok, false);
});
test('rate limit resets after ten seconds', () => {
  const e = new CaseEngine(new Journal(), 'test'); const ingest = new Ingest(e, 'channel-test');
  const base = { eventId: '', messageId: 'm', channelId: 'channel-test', userId: 'u', login: 'u', text: '!docket', at: 1000, role: 'viewer' as const };
  for (let i = 0; i < 5; i++) assert.equal(ingest.accept({ ...base, eventId: String(i) }, 1000).ok, true);
  assert.match(ingest.accept({ ...base, eventId: 'six' }, 1000).detail, /rate limit/);
  assert.equal(ingest.accept({ ...base, eventId: 'seven', at: 11000 }, 11000).ok, true);
});
test('replay after an ingest restart preserves committed votes and cases', async () => {
  const e = new CaseEngine(new Journal(), 'test');
  const source = new FakeEventSub(new URL('../fixtures/chat.jsonl', import.meta.url));
  for (let i = 0; i < 2; i++) {
    const ingest = new Ingest(e, 'channel-test');
    await source.start(raw => {
      const c = normalize(raw)!;
      assert.equal(ingest.accept(c, c.at).ok, true);
    });
    e.tick(e.list()[0].deadline!);
  }
  assert.equal(e.list().length, 1);
  assert.equal(Object.keys(e.list()[0].votes).length, 3);
});
