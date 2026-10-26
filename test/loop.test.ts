import test from 'node:test';
import assert from 'node:assert/strict';
import { VoteLoop } from '../src/loop.ts';
import { replay } from '../src/replay.ts';

async function fixture(autoApprove = false) {
  let now = 1000000;
  const loop = new VoteLoop({ now: () => now, autoApprove });
  await replay(loop, { now: () => now, sleep: async ms => { now += ms; loop.tick(); }, runId: 'test' });
  return { loop, setTime: (n: number) => { now = n; loop.tick(); } };
}
test('fixture drives card, weighted vote, deadline, approval and gavel', async () => {
  const { loop, setTime } = await fixture(true);
  const card = loop.snapshot().current!;
  assert.equal(card.state, 'voting');
  assert.equal(Object.keys(card.votes).length, 3);
  assert.equal(Object.values(card.votes).reduce((n, v) => n + v.weight, 0), 5);
  setTime(card.deadline!);
  assert.equal(loop.snapshot().current!.state, 'awaiting_approval');
  setTime(card.deadline! + 1500);
  setTime(card.deadline! + 1800);
  assert.equal(loop.snapshot().current!.state, 'ruling');
  assert.equal(loop.snapshot().current!.verdict, 'guilty');
  assert.equal(loop.snapshot().gavel, true);
  setTime(card.deadline! + 5000);
  assert.equal(loop.snapshot().current!.state, 'appeal_window');
  assert.equal(loop.snapshot().gavel, false);
  loop.dispose();
});
test('Space closes early and veto wins competing decisions', async () => {
  const { loop, setTime } = await fixture();
  const id = loop.snapshot().current!.id;
  loop.control('close', id);
  assert.equal(loop.snapshot().current!.state, 'awaiting_approval');
  loop.control('approve', id);
  loop.control('veto', id);
  loop.control('approve', id);
  setTime(1005500);
  assert.equal(loop.snapshot().current!.verdict, 'notguilty');
  assert.equal(loop.snapshot().current!.timeoutSeconds, 0);
  assert.throws(() => loop.control('approve', 'wrong-case'), /stale/i);
  loop.dispose();
});
test('manual mode waits for the operator and refuses approval during voting', async () => {
  const { loop, setTime } = await fixture();
  const c = loop.snapshot().current!;
  assert.throws(() => loop.control('approve', c.id), /Close voting/);
  setTime(c.deadline! + 5000);
  assert.equal(loop.snapshot().current!.state, 'awaiting_approval');
  assert.equal(loop.snapshot().gavel, false);
  loop.dispose();
});
test('replay uses fresh ids, preserves duplicate delivery, and rejects overlapping runs', async () => {
  const { loop, setTime } = await fixture(true);
  await assert.rejects(replay(loop), /active case/);
  const deadline = loop.snapshot().current!.deadline!;
  setTime(deadline); setTime(deadline + 1500); setTime(deadline + 1800); setTime(deadline + 5000);
  setTime(deadline + 125000);
  assert.equal(loop.snapshot().current!.state, 'closed');
  let now = deadline + 126000;
  // A separate loop can run the same fixture without depending on its recorded date.
  const second = new VoteLoop({ now: () => now });
  await replay(second, { now: () => now, sleep: async ms => { now += ms; }, runId: 'second' });
  assert.equal(second.snapshot().cases.length, 1);
  assert.equal(Object.keys(second.snapshot().current!.votes).length, 3);
  second.dispose(); loop.dispose();
});
