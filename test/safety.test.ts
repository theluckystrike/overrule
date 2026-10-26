import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
import { Ingest } from '../src/ingest.ts';
import { VoteLoop } from '../src/loop.ts';
import { DryRunHelix } from '../src/helix.ts';
const evidence = { id: 'm', userId: 'u', login: 'alt', text: 'private evidence', at: 1000 };
const chat = { eventId: 'm', messageId: 'm', channelId: 'channel-test', userId: 'u', login: 'alt', text: 'private evidence', at: 1000, role: 'viewer' as const };
function ready(loop: VoteLoop) { const c = loop.engine.open('o', evidence, 'Spam', 1000); loop.engine.advance('e', c.id, 'evidence', 1000); loop.engine.advance('v', c.id, 'voting', 1000); return c.id; }
test('streamer and moderators are immune and VIP immunity is configurable', () => {
  for (const role of ['broadcaster', 'moderator', 'vip'] as const) {
    const engine = new CaseEngine(new Journal(), 's');
    assert.throws(() => engine.open('o', { ...evidence, role }, 'Spam', 1000), /immune/);
  }
  const engine = new CaseEngine(new Journal(), 's', { vipImmune: false });
  assert.equal(engine.open('o', { ...evidence, role: 'vip' }, 'Spam', 1000).state, 'open');
  assert.throws(() => engine.open('second', { ...evidence, userId: 'other' }, 'Spam', 1000), /active case/);
});
test('viewer reports remain private until operator promotion and subscriber votes can be required', () => {
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'channel-test', { subscribersOnly: true });
  ingest.accept(chat, 1000);
  assert.equal(ingest.accept({ ...chat, eventId: 'r', userId: 'reporter', text: '!report Spam', replyTo: 'm' }, 1000).ok, true);
  assert.equal(engine.list().length, 0); assert.equal(ingest.queue(1000).length, 1);
  const id = ingest.promote('channel-test/r', 1000);
  assert.equal(engine.get(id).state, 'voting');
  const vote = { ...chat, eventId: 'vote', userId: 'juror', text: '!guilty' };
  assert.equal(ingest.accept(vote, 1000).ok, false);
  assert.equal(ingest.accept({ ...vote, subscriber: true }, 1000).ok, true);
});
test('public snapshots hide evidence until reveal and deletion removes it again', () => {
  const loop = new VoteLoop({ now: () => 1000 }); const id = ready(loop);
  assert.equal(loop.snapshot().current?.message.text, '');
  assert.equal(loop.snapshot(true).current?.message.text, evidence.text);
  loop.control('reveal', id); assert.equal(loop.snapshot().current?.message.text, evidence.text);
  loop.accept({ metadata: { message_type: 'notification', message_id: 'delete', message_timestamp: new Date(1000).toISOString() }, payload: { subscription: { type: 'channel.chat.message_delete' }, event: { broadcaster_user_id: 'channel-test', message_id: 'm' } } });
  assert.equal(loop.snapshot(true).current?.message.text, '');
  assert.throws(() => loop.control('reveal', id), /removed/); loop.dispose();
});
test('user clear removes cached and queued evidence and blocks late delivery', () => {
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'channel-test');
  ingest.accept(chat, 1000); ingest.accept({ ...chat, eventId: 'r', text: '!report Spam', replyTo: 'm' }, 1000);
  ingest.remove({ channelId: 'channel-test', userId: 'u', at: 1000 }, 1000);
  assert.equal(ingest.queue(1000).length, 0);
  ingest.accept({ ...chat, eventId: 'late' }, 1001);
  assert.equal(ingest.accept({ ...chat, eventId: 'mod', userId: 'mod', role: 'moderator', text: '!case @alt Spam' }, 1001).ok, false);
});
test('A cannot default to guilty without quorum but explicit G can and V still wins', () => {
  let now = 1000; const loop = new VoteLoop({ now: () => now }); const id = ready(loop);
  loop.control('close', id); assert.throws(() => loop.control('approve', id), /No result/);
  assert.equal(loop.snapshot().pending, null);
  loop.control('force-guilty', id); loop.control('veto', id); now += 301; loop.tick();
  assert.equal(loop.engine.get(id).verdict, 'notguilty'); loop.dispose();
  const second = new VoteLoop({ now: () => now }); const next = ready(second); second.control('close', next); second.control('force-guilty', next); now += 301; second.tick();
  assert.equal(second.engine.get(next).verdict, 'guilty'); second.dispose();
});
test('automatic approval cannot be combined with live Helix', () => {
  const helix = new DryRunHelix(); Object.defineProperty(helix, 'mode', { value: 'live' });
  assert.throws(() => new VoteLoop({ helix, autoApprove: true }), /Automatic approval/);
});
test('operator promotion is the only path from a private viewer report to a public case', async () => {
  const loop = new VoteLoop({ now: () => 1000 });
  const raw = (id: string, user: string, text: string, reply?: object) => ({ metadata: { message_id: id, message_type: 'notification', message_timestamp: new Date(1000).toISOString() }, payload: { subscription: { type: 'channel.chat.message' }, event: { broadcaster_user_id: 'channel-test', chatter_user_id: user, chatter_user_login: user, message_id: id, message: { text }, reply } } });
  loop.accept(raw('target', 'alt', 'Private reported text'));
  loop.accept(raw('report', 'viewer', '@alt !report Spam', { parent_message_id: 'target', parent_user_login: 'alt' }));
  assert.equal(loop.snapshot().current, null); assert.equal(loop.snapshot().reports.length, 0);
  assert.equal(loop.snapshot(true).reports.length, 1);
  loop.control('promote', loop.snapshot(true).reports[0].id);
  assert.equal(loop.snapshot().current?.state, 'voting'); assert.equal(loop.snapshot().current?.message.text, '');
  await loop.flush(); loop.dispose();
});
test('removed evidence cannot cause a new timeout and foreign deletes do nothing', () => {
  const loop = new VoteLoop({ now: () => 1000 }); const id = ready(loop);
  const removal = (channel: string) => ({ metadata: { message_type: 'notification', message_timestamp: new Date(1000).toISOString() }, payload: { subscription: { type: 'channel.chat.clear_user_messages' }, event: { broadcaster_user_id: channel, target_user_id: 'u' } } });
  loop.accept(removal('wrong')); assert.equal(loop.snapshot(true).current?.message.text, evidence.text);
  loop.accept(removal('channel-test')); loop.control('close', id);
  loop.engine.decide('d', id, 'guilty', true, 1000);
  assert.equal(loop.engine.get(id).state, 'expired'); assert.equal(loop.engine.get(id).timeoutSeconds, 0); loop.dispose();
});
