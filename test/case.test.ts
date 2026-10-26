import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';

const setup = () => new CaseEngine(new Journal(), 'stream-1');
const message = { id: 'm1', userId: 'accused', login: 'alt', text: 'test message', at: 1000 };
function voting(engine: CaseEngine) {
  const c = engine.open('open-1', message, 'Be kind', 1000);
  engine.advance('evidence-1', c.id, 'evidence', 1000);
  engine.advance('voting-1', c.id, 'voting', 1000);
  return c.id;
}
test('duplicate operations and one active case per accused', () => {
  const e = setup();
  const id = voting(e);
  assert.equal(e.open('open-1', message, 'Be kind', 1000).id, id);
  assert.throws(() => e.open('open-2', message, 'Other reason', 1000), /active/);
  assert.equal(e.list().length, 1);
  assert.throws(() => e.advance('skip', id, 'closed', 1000), /transition/);
});
test('vote replacement, trusted weights, self exclusion, deadline and quorum', () => {
  const e = setup(); const id = voting(e);
  assert.throws(() => e.vote('self', id, 'accused', 'Alt', 'viewer', 'guilty', 1001), /accused/);
  e.vote('v1', id, 'u1', 'One', 'moderator', 'guilty', 1001);
  e.vote('v2', id, 'u1', 'One', 'moderator', 'notguilty', 1002);
  assert.equal(e.get(id).votes.u1.changed, true);
  assert.equal(e.get(id).votes.u1.weight, 3);
  assert.throws(() => e.vote('late', id, 'u2', 'Two', 'viewer', 'guilty', 26000), /deadline/);
  e.tick(26000);
  assert.equal(e.get(id).jury, null);
  assert.equal(e.get(id).state, 'awaiting_approval');
});
test('quorum counts people and ties do not recommend guilt', () => {
  const e = setup(); const id = voting(e);
  for (let i = 0; i < 3; i++) e.vote(`v${i}`, id, `u${i}`, 'Test', 'viewer', 'guilty', 1001);
  e.tick(26000);
  assert.equal(e.get(id).jury, 'guilty');
});
test('raid burst is contested and approval is always explicit', () => {
  const e = setup(); const id = voting(e);
  for (let i = 0; i < 41; i++) e.vote(`v${i}`, id, `u${i}`, 'Test', 'viewer', 'guilty', 1001 + i);
  assert.equal(e.get(id).contested, true);
  e.tick(26000);
  assert.throws(() => e.decide('decision', id, 'guilty', false, 26001), /streamer/);
  e.decide('decision', id, 'guilty', true, 26001);
  assert.equal(e.get(id).state, 'ruling');
  assert.equal(e.get(id).timeoutSeconds, 600);
});
test('stale messages, veto, one appeal per stream and closure', () => {
  const e = setup();
  assert.throws(() => e.open('stale', message, 'Rule', 121001), /old/);
  const id = voting(e); e.tick(26000);
  e.decide('veto', id, 'notguilty', true, 26001);
  assert.equal(e.get(id).timeoutSeconds, 0);
  e.advance('window', id, 'appeal_window', 26002);
  e.appeal('appeal', id, 'accused', 26003);
  assert.throws(() => e.appeal('appeal2', id, 'accused', 26004), /one appeal/);
  e.resolveAppeal('resolve', id, true, true, 26005);
  assert.equal(e.get(id).state, 'closed');
  assert.equal(e.get(id).message.text, '');
  assert.equal(e.get(id).reason, '');
});
test('state reads cannot mutate the engine and stale approval cannot time out', () => {
  const e = setup(); const id = voting(e);
  e.get(id).state = 'closed';
  assert.equal(e.get(id).state, 'voting');
  e.tick(130000);
  assert.throws(() => e.decide('old', id, 'guilty', true, 130000), /old/);
});
test('tie yields no jury result and early close rejects subsequent votes', () => {
  const e = setup(); const id = voting(e);
  e.vote('v1', id, 'mod', 'Mod', 'moderator', 'guilty', 1001);
  for (let i = 0; i < 3; i++) e.vote(`v-${i}`, id, `u${i}`, 'Viewer', 'viewer', 'notguilty', 1002);
  e.advance('space', id, 'awaiting_approval', 1003);
  assert.equal(e.get(id).jury, null);
  assert.throws(() => e.vote('late', id, 'u4', 'Viewer', 'viewer', 'guilty', 1004), /voting not open/);
});
test('appeals require identity, deadline and streamer decision', () => {
  const e = setup(); const id = voting(e); e.tick(26000);
  e.decide('approve', id, 'guilty', true, 26001);
  e.advance('window', id, 'appeal_window', 26002);
  assert.throws(() => e.appeal('other', id, 'stranger', 26003), /not available/);
  e.appeal('appeal', id, 'accused', 26003);
  e.tick(200000);
  assert.equal(e.get(id).state, 'appeal_window');
  assert.throws(() => e.resolveAppeal('no', id, true, false, 200001), /streamer/);
  e.resolveAppeal('yes', id, true, true, 200001);
  assert.equal(e.get(id).verdict, 'notguilty');
  const c2 = e.open('second', { ...message, id: 'm2', at: 200002 }, 'Be kind', 200002);
  e.advance('e2', c2.id, 'evidence', 200002);
  e.advance('v2', c2.id, 'voting', 200002);
  e.tick(225002);
  e.decide('d2', c2.id, 'notguilty', true, 225003);
  e.advance('w2', c2.id, 'appeal_window', 225004);
  assert.throws(() => e.appeal('a2', c2.id, 'accused', 225005), /one appeal/);
});
test('replaced votes cannot manufacture a raid burst', () => {
  const e = setup(); const id = voting(e);
  for (let i = 0; i < 45; i++) e.vote(`change-${i}`, id, 'u1', 'One', 'viewer', 'guilty', 1001 + i);
  assert.equal(e.get(id).contested, false);
  assert.equal(Object.keys(e.get(id).votes).length, 1);
});
test('invalid clocks cannot corrupt state', () => {
  const e = setup(); const id = voting(e);
  assert.throws(() => e.advance('bad-time', id, 'awaiting_approval', NaN), /clock/);
  assert.equal(e.get(id).state, 'voting');
});
