import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpHelix, createLiveHelix, HelixFailure } from '../src/helix.ts';
import { DisabledOAuth } from '../src/auth.ts';
import { fakeHelix } from './helpers/fake-helix.ts';
const client = (baseUrl: string, timeoutMs = 1000) => new HttpHelix({ baseUrl, clientId: 'fake-client', token: async () => 'fake-token', broadcasterId: 'channel-test', moderatorId: 'mod', timeoutMs });
test('Helix timeout, chat verdict and owned timeout release use the documented routes', async () => {
  const fake = await fakeHelix();
  try {
    const helix = client(fake.baseUrl);
    const receipt = await helix.timeout('case-1', 'accused', 600);
    await helix.verdict('case-1', 'Test verdict');
    await helix.release('case-1', 'accused', receipt);
    assert.deepEqual(fake.calls.map(c => `${c.method} ${c.path}`), ['POST /helix/moderation/bans', 'POST /helix/chat/messages', 'GET /helix/moderation/banned', 'DELETE /helix/moderation/bans']);
    assert.equal(fake.calls[0].body.data.duration, 600);
    assert.equal(fake.calls[1].body.message, 'Test verdict');
    assert.equal(fake.calls[3].query.user_id, 'accused');
    await assert.rejects(helix.timeout('bad', 'u', 601), /between/);
    assert.equal(fake.calls.length, 4);
  } finally { await fake.close(); }
});
test('changed or permanent bans cannot be removed by an appeal', async () => {
  const fake = await fakeHelix();
  try {
    const helix = client(fake.baseUrl); const receipt = await helix.timeout('c', 'accused', 600);
    fake.replaceBan(); await assert.rejects(helix.release('c', 'accused', receipt), /changed/);
    assert.equal(fake.calls.filter(c => c.method === 'DELETE').length, 0);
  } finally { await fake.close(); }
});
test('dropped verdicts and HTTP errors fail without exposing remote bodies', async () => {
  const fake = await fakeHelix();
  try {
    const helix = client(fake.baseUrl); fake.setDropped();
    await assert.rejects(helix.verdict('c', 'Test'), /dropped/);
    fake.setStatus(401); await assert.rejects(helix.timeout('c', 'u', 600), e => e instanceof HelixFailure && !e.uncertain && !e.message.includes('SECRET'));
    fake.setStatus(503); await assert.rejects(helix.timeout('c', 'u', 600), e => e instanceof HelixFailure && e.uncertain);
  } finally { await fake.close(); }
});
test('network deadlines yield an unknown outcome and do not retry writes', async () => {
  const fake = await fakeHelix();
  try {
    fake.setHang(); await assert.rejects(client(fake.baseUrl, 20).timeout('c', 'u', 600), e => e instanceof HelixFailure && e.uncertain);
    assert.equal(fake.calls.length, 1);
  } finally { await fake.close(); }
});
test('live gate rejects before reading credentials and remote endpoints are restricted', async () => {
  await assert.rejects(createLiveHelix({ oauth: new DisabledOAuth(), broadcasterId: 'b', moderatorId: 'm' }), /OWNER-NEEDED/);
  await assert.rejects(createLiveHelix({ oauth: new DisabledOAuth(), broadcasterId: 'b', moderatorId: 'm', ownerGate: true }), /broadcaster token/);
  assert.throws(() => client('https://api.twitch.tv/helix/'), /gate is closed/);
  assert.throws(() => client('https://example.com/helix/'), /endpoint/);
});
