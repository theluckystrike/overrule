import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
import { Ingest, normalize } from '../src/ingest.ts';
import { VoteLoop } from '../src/loop.ts';
import { DryRunHelix } from '../src/helix.ts';
import { FakeEventSub } from '../src/eventsub.ts';
const evidence = { id: 'm', userId: 'u', login: 'alt', text: 'spam', at: 1000 };
function ready(e: CaseEngine) { const c = e.open('o', evidence, 'Spam', 120000); e.advance('e', c.id, 'evidence', 120000); e.advance('v', c.id, 'voting', 120000); e.tick(145000); return c.id; }
test('approval age uses case opening and expiry is not an acquittal', () => {
  const e = new CaseEngine(new Journal(), 'stream'); const id = ready(e);
  e.decide('decision', id, 'guilty', true, 150000);
  assert.equal(e.get(id).verdict, 'guilty');
  const expired = new CaseEngine(new Journal(), 'stream'); const old = ready(expired);
  expired.tick(420000);
  assert.equal(expired.get(old).state, 'expired');
  assert.equal(expired.get(old).verdict, null);
  assert.equal(expired.get(old).timeoutSeconds, 0);
});
test('expired court posts an explicit expiry message without a timeout', async () => {
  const journal = new Journal(); const e = new CaseEngine(journal, 'stream'); const id = ready(e);
  const helix = new DryRunHelix(); let text = '';
  helix.verdict = async (_id, message) => { text = message; };
  const loop = new VoteLoop({ journal, now: () => 420000, helix }); loop.tick(); await loop.flush();
  assert.equal(loop.engine.get(id).state, 'expired'); assert.match(text, /Ruling expired. No action/);
  assert.equal(helix.calls.length, 0); loop.dispose();
});
test('moderator can file an appeal for a timed-out target but viewers cannot proxy it', () => {
  const e = new CaseEngine(new Journal(), 'stream'); const id = ready(e);
  e.decide('d', id, 'guilty', true, 150000); e.advance('w', id, 'appeal_window', 150001);
  const ingest = new Ingest(e, 'channel');
  const message = { eventId: 'proxy', messageId: 'proxy', channelId: 'channel', userId: 'mod', login: 'mod', text: '!appeal @alt', at: 150002, role: 'viewer' as const };
  assert.equal(ingest.accept(message, 150002).ok, false);
  assert.equal(ingest.accept({ ...message, eventId: 'mod-proxy', role: 'moderator' }, 150002).ok, true);
  assert.equal(e.get(id).appealFiledBy, 'mod');
  assert.equal(ingest.accept({ ...message, eventId: 'second', role: 'moderator' }, 150003).ok, false);
});
test('Twitch reply mention prefix is removed only for the actual parent login', async () => {
  const e = new CaseEngine(new Journal(), 'stream'); const ingest = new Ingest(e, 'channel-test');
  await new FakeEventSub(new URL('../fixtures/reply-report.jsonl', import.meta.url)).start(raw => {
    const event = normalize(raw)!; assert.equal(ingest.accept(event, event.at).ok, true);
  });
  assert.equal(e.list().length, 1); assert.equal(e.list()[0].message.id, 'target-reply');
});
