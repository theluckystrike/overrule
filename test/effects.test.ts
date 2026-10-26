import test from 'node:test';
import assert from 'node:assert/strict';
import { VoteLoop } from '../src/loop.ts';
import { replay } from '../src/replay.ts';
import { HttpHelix, DryRunHelix } from '../src/helix.ts';
import { fakeHelix } from './helpers/fake-helix.ts';
import { Journal, consistency } from '../src/precedent.ts';
import { CaseEngine } from '../src/case.ts';
import { Brain } from '../src/brain.ts';

async function setup(helix: HttpHelix | DryRunHelix, journal = new Journal()) {
  let now = 1000000;
  const loop = new VoteLoop({ journal, now: () => now, helix, brain: new Brain({ key: '' }) });
  await replay(loop, { now: () => now, sleep: async ms => { now += ms; }, runId: 'effects' });
  await loop.flush();
  const id = loop.snapshot().current!.id;
  loop.control('close', id); loop.control('approve', id);
  now += 300; loop.tick(); await loop.flush();
  return { loop, id, advance: async (ms: number) => { now += ms; loop.tick(); await loop.flush(); } };
}
test('fake Helix receives one timeout and verdict, then one release and appeal verdict', async () => {
  const fake = await fakeHelix();
  try {
    const helix = new HttpHelix({ baseUrl: fake.baseUrl, clientId: 'fake-client', token: async () => 'fake-token', broadcasterId: 'channel-test', moderatorId: 'mod' });
    const { loop, id, advance } = await setup(helix);
    assert.equal(loop.engine.get(id).analysis?.source, 'fallback');
    assert.equal(loop.engine.get(id).effects?.timeout?.status, 'sent');
    await advance(3000);
    loop.control('demo-appeal', id); loop.control('overturn', id); await loop.flush();
    assert.equal(loop.engine.get(id).state, 'closed');
    assert.equal(loop.engine.get(id).verdict, 'notguilty');
    assert.equal(loop.engine.get(id).effects?.release?.status, 'sent');
    await advance(1000); await advance(1000);
    assert.equal(fake.calls.filter(c => c.path.endsWith('/bans') && c.method === 'POST').length, 1);
    assert.equal(fake.calls.filter(c => c.path.endsWith('/bans') && c.method === 'DELETE').length, 1);
    assert.equal(fake.calls.filter(c => c.path.endsWith('/messages')).length, 2);
    assert.match(fake.calls.filter(c => c.path.endsWith('/messages'))[1].body.message, /Overturned/);
    loop.dispose();
  } finally { await fake.close(); }
});
test('recovered pending actions become unknown and are not resent', async () => {
  const journal = new Journal(); const helix = new DryRunHelix();
  const { loop, id } = await setup(helix, journal);
  loop.dispose();
  const restored = new VoteLoop({ journal, helix, now: () => 1010000 });
  restored.tick(); await restored.flush();
  assert.equal(helix.calls.filter(c => c === `timeout/${id}`).length, 1);
  // Use a separate journal to represent a process lost after durable intent.
  const pendingJournal = new Journal(); const pending = new CaseEngine(pendingJournal, 'crash');
  const c = pending.open('open', { id: 'm', userId: 'u', login: 'alt', text: 'test', at: 1000 }, 'Spam', 1000);
  pending.advance('e', c.id, 'evidence', 1000); pending.advance('v', c.id, 'voting', 1000); pending.advance('s', c.id, 'awaiting_approval', 2000); pending.decide('d', c.id, 'guilty', true, 2000);
  pending.effect(c.id, 'timeout', { status: 'pending', mode: 'dry-run' }, 2000);
  const recovery = new VoteLoop({ journal: pendingJournal, helix, now: () => 3000 });
  recovery.tick(); await recovery.flush();
  assert.equal(recovery.engine.get(c.id).effects?.timeout?.status, 'unknown');
  assert.equal(helix.calls.filter(x => x === `timeout/${c.id}`).length, 0);
  restored.dispose(); recovery.dispose();
});
test('failed timeout does not claim success and is not retried on timer ticks', async () => {
  const fake = await fakeHelix(); fake.setStatus(403);
  try {
    const { loop, id, advance } = await setup(new HttpHelix({ baseUrl: fake.baseUrl, clientId: 'fake-client', token: async () => 'fake-token', broadcasterId: 'channel-test', moderatorId: 'mod' }));
    assert.equal(loop.engine.get(id).effects?.timeout?.status, 'failed');
    assert.match(fake.calls[1].body.message, /unconfirmed/);
    await advance(1000); await advance(1000);
    assert.equal(fake.calls.length, 2); loop.dispose();
  } finally { await fake.close(); }
});
test('upholding an appeal sends a final verdict without releasing the timeout', async () => {
  const helix = new DryRunHelix(); const { loop, id, advance } = await setup(helix);
  await advance(3000); loop.control('demo-appeal', id); loop.control('uphold', id); await loop.flush();
  assert.equal(loop.engine.get(id).verdict, 'guilty');
  assert.equal(helix.calls.some(c => c.startsWith('release/')), false);
  assert.equal(loop.engine.get(id).effects?.appealVerdict?.status, 'sent');
  const first = { ...loop.engine.get(id), id: 'first', verdict: 'notguilty' as const };
  assert.equal(consistency([first, loop.engine.get(id)]), 0);
  loop.dispose();
});
test('overturned appeal changes the consistency score and next fallback precedent', async () => {
  const helix = new DryRunHelix(); const { loop, id, advance } = await setup(helix);
  await advance(3000); loop.control('demo-appeal', id); loop.control('overturn', id); await loop.flush();
  const final = loop.engine.get(id);
  const previous = { ...final, id: 'earlier', verdict: 'guilty' as const, overturned: false };
  assert.equal(consistency([previous, final]), 0);
  assert.equal(consistency([previous, { ...final, verdict: 'guilty' }]), 1);
  assert.equal(new Brain().fallback({ ...final, id: 'next' }, [final]).precedentId, id);
  loop.dispose();
});
