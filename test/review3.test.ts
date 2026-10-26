import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, Ingest } from '../src/ingest.ts';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
import { TwitchOAuth } from '../src/auth.ts';
import { liveRuntime, authorizationServer } from '../src/live.ts';
import { twitchMock, MemoryTokens } from './helpers/twitch-mock.ts';
function event(id: string, user: string, text: string, extra: Record<string, unknown> = {}) {
  return normalize({ metadata: { message_id: id, message_type: 'notification', message_timestamp: new Date(1000).toISOString() }, payload: { subscription: { type: 'channel.chat.message' }, event: { broadcaster_user_id: 'host', chatter_user_id: user, chatter_user_login: user, message_id: id, message: { text }, badges: [], ...extra } } })!;
}
test('R1 shared source broadcaster and moderator badges preserve immunity', () => {
  for (const [user, badges, role] of [['partner', [], 'broadcaster'], ['mod', [{ set_id: 'moderator' }], 'moderator'], ['lead', [{ set_id: 'lead_moderator' }], 'moderator']] as const) {
    const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'host');
    const guest = event('guest', user, 'hello', { source_broadcaster_user_id: 'partner', source_message_id: 'original', source_badges: badges });
    assert.equal(guest.role, role); ingest.accept(guest, 1000);
    const trial = event('trial', 'host', `!case @${user} Spam`);
    assert.equal(ingest.accept(trial, 1000).ok, false); assert.equal(engine.list().length, 0);
  }
});
test('R1 shared guests cannot supply evidence, report, command or vote', () => {
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'host');
  const shared = { source_broadcaster_user_id: 'partner', source_badges: [{ set_id: 'moderator' }] };
  ingest.accept(event('local', 'alt', 'spam'), 1000);
  ingest.accept(event('guest', 'guest', 'spam', shared), 1000);
  assert.equal(ingest.accept(event('try', 'host', '!case @guest Spam'), 1000).ok, false);
  ingest.accept(event('report', 'guest', '!report local Spam', shared), 1000); assert.equal(ingest.queue(1000).length, 0);
  ingest.accept(event('command', 'guest', '!case @alt Spam', shared), 1000); assert.equal(engine.list().length, 0);
  ingest.accept(event('open', 'host', '!case @alt Spam'), 1000);
  ingest.accept(event('vote', 'guest', '!guilty', shared), 1000); assert.equal(Object.keys(engine.list()[0].votes).length, 0);
});
test('R2 real actions require an expected login before runtime construction', async () => {
  const mock = await twitchMock(); const store = new MemoryTokens();
  const auth = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/' });
  const previous = process.env.OVERRULE_EXPECTED_LOGIN;
  try {
    await auth.authorizationUrl('a'.repeat(64)); await auth.exchange('mock-code', 'a'.repeat(64));
    delete process.env.OVERRULE_EXPECTED_LOGIN;
    let runtime: ReturnType<typeof liveRuntime> | undefined;
    try { assert.throws(() => { runtime = liveRuntime(auth, mock.app, { journal: new Journal(), allowActions: true }); }, /OVERRULE_EXPECTED_LOGIN/); }
    finally { await runtime?.stop(); }
  } finally { if (previous === undefined) delete process.env.OVERRULE_EXPECTED_LOGIN; else process.env.OVERRULE_EXPECTED_LOGIN = previous; auth.stopValidation(); await mock.close(); }
});
test('R4 reply case uses its parent and non-reply target needs an at sign', () => {
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'host');
  ingest.accept(event('bad', 'alt', 'spam'), 1000); ingest.accept(event('bystander', 'spamming', 'hello'), 1000);
  assert.equal(ingest.accept(event('unqualified', 'host', '!case spamming links'), 1000).ok, false);
  const reply = { reply: { parent_message_id: 'bad', parent_user_login: 'alt' } };
  assert.equal(ingest.accept(event('mismatch', 'host', '@alt !case @spamming links', reply), 1000).ok, false);
  assert.equal(ingest.accept(event('correct', 'host', '@alt !case spamming links', reply), 1000).ok, true);
  assert.equal(engine.list()[0].message.userId, 'alt');
});
test('R2 mismatched saved identity opens authorization and can be replaced by the expected account', async t => {
  const { prepareAuthorization } = await import('../src/live.ts');
  const mock = await twitchMock(); const store = new MemoryTokens();
  const auth = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/' });
  const messages: string[] = []; t.mock.method(console, 'log', (s: string) => messages.push(s));
  let gate: ReturnType<typeof authorizationServer> | undefined;
  try {
    await auth.authorizationUrl('a'.repeat(64)); await auth.exchange('mock-code', 'a'.repeat(64));
    const restored = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/' });
    assert.equal(await prepareAuthorization(restored, 'testowner'), false);
    assert.ok(messages.includes('Authorized login owner does not match expected testowner'));
    assert.throws(() => restored.identity(), /authorization/);
    gate = authorizationServer(restored, 'testowner');
    await new Promise<void>(r => gate!.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(gate.server.address() as { port: number }).port}`;
    const authorize = async () => {
      const response = await fetch(base + '/auth', { redirect: 'manual' });
      const state = new URL(response.headers.get('location')!).searchParams.get('state');
      return fetch(base + `/auth/callback?code=mock-code&state=${state}`, { headers: { Cookie: response.headers.get('set-cookie')!.split(';')[0] } });
    };
    const wrong = await authorize(); assert.equal(wrong.status, 400); assert.match(await wrong.text(), /Authorized login owner does not match expected testowner/);
    mock.identity('testowner', 'new-owner-id');
    assert.equal((await authorize()).status, 200); await gate.authorized;
    assert.equal(restored.identity().userId, 'new-owner-id');
  } finally { if (gate) { gate.server.closeAllConnections(); await new Promise<void>(r => gate!.server.close(() => r())); } auth.stopValidation(); await mock.close(); }
});
test('R3 slow validation at reconnect and unused close code recover without stopping the court', async () => {
  const { LiveEventSub } = await import('../src/eventsub.ts'); const { until } = await import('./helpers/twitch-mock.ts');
  const mock = await twitchMock(); let now = 1000; let fatal = false;
  const auth = new TwitchOAuth(mock.app, new MemoryTokens(), { baseUrl: mock.base + '/oauth2/', now: () => now });
  await auth.authorizationUrl('a'.repeat(64)); await auth.exchange('mock-code', 'a'.repeat(64));
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10, authorizationTimeoutMs: 80, onFatal: () => { fatal = true; } });
  try {
    await source.start(() => {}); now += 3600000; mock.fault('/oauth2/validate', 'timeout'); mock.peers.at(-1)!.terminate();
    await until(() => mock.calls.filter(c => c.path.endsWith('/validate')).length === 2);
    mock.peers.at(-1)!.close(4003, 'Connection unused');
    await until(() => mock.subscriptions.length === 8, 3000);
    assert.equal(fatal, false);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(mock.peers.length, 3, 'A stale subscription must not replace the recovered socket');
  } finally { source.stop(); auth.stopValidation(); await mock.close(); }
});
test('R1 a local message keeps local privileges and cannot inherit guest command authority', () => {
  const local = event('local', 'mod', 'hello', { source_broadcaster_user_id: 'host', source_badges: [{ set_id: 'moderator' }] });
  assert.equal(local.role, 'moderator'); assert.equal(local.guest, false);
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'host');
  ingest.accept(event('prior', 'partner', 'older local text'), 1000);
  ingest.accept(event('guest', 'partner', 'shared text', { source_broadcaster_user_id: 'partner', source_badges: [{ set_id: 'broadcaster' }] }), 1000);
  assert.equal(ingest.accept(event('try', 'host', '!case @partner Spam'), 1000).ok, false);
});
