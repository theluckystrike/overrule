import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TwitchOAuth, REQUIRED_SCOPES } from '../src/auth.ts';
import { LiveEventSub } from '../src/eventsub.ts';
import { HttpHelix } from '../src/helix.ts';
import { Journal } from '../src/precedent.ts';
import { authorizationServer, liveRuntime } from '../src/live.ts';
import { twitchMock, MemoryTokens, until } from './helpers/twitch-mock.ts';
async function authorized(mock: Awaited<ReturnType<typeof twitchMock>>, now?: () => number) {
  const store = new MemoryTokens(); const auth = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/', now });
  const state = 'a'.repeat(64); await auth.authorizationUrl(state); await auth.exchange('mock-code', state);
  return { auth, store };
}
test('OAuth exchange checks state, refreshes before expiry and validates hourly', async () => {
  const mock = await twitchMock(); let now = 1000;
  try {
    const { auth, store } = await authorized(mock, () => now);
    assert.equal(auth.identity().userId, 'owner');
    assert.equal(mock.calls.filter(c => c.path.endsWith('/validate')).length, 1);
    await assert.rejects(auth.exchange('mock-code', 'a'.repeat(64)), /state/);
    now += 3600000; await auth.accessToken();
    assert.equal(mock.calls.filter(c => c.path.endsWith('/validate')).length, 2);
    now += 3600000; await auth.accessToken();
    assert.equal(mock.calls.filter(c => c.body.grant_type === 'refresh_token').length, 1);
    assert.ok(store.value!.expiresAt > now);
    const restored = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/', now: () => now });
    assert.equal(await restored.initialize(), true);
    mock.revoke(); await assert.rejects(restored.validate(), /authorization/);
    await assert.rejects(restored.accessToken(), /authorization/);
  } finally { await mock.close(); }
});
test('OAuth mismatched scopes and callback without browser state are rejected', async () => {
  const mock = await twitchMock();
  const auth = new TwitchOAuth(mock.app, new MemoryTokens(), { baseUrl: mock.base + '/oauth2/' });
  const gate = authorizationServer(auth);
  await new Promise<void>(r => gate.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(gate.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + '/auth/callback?code=mock-code&state=bad')).status, 400);
    const response = await fetch(base + '/auth', { redirect: 'manual' });
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(base + `/auth/callback?code=mock-code&state=${state}`, { headers: { cookie } })).status, 200);
    await gate.authorized;
    mock.scopes(REQUIRED_SCOPES.slice(0, 1)); await assert.rejects(auth.validate(), /scopes/);
  } finally { gate.server.closeAllConnections(); await new Promise<void>(r => gate.server.close(() => r())); await mock.close(); }
});
test('Helix 401 refreshes once and retries with the validated token', async () => {
  const mock = await twitchMock();
  try {
    const { auth } = await authorized(mock); mock.expire();
    const helix = new HttpHelix({ baseUrl: mock.base + '/helix/', clientId: mock.app.client_id, broadcasterId: 'owner', moderatorId: 'owner', token: () => auth.accessToken(), refreshAfter401: t => auth.refreshAfter401(t) });
    await helix.verdict('case', 'Mock verdict');
    assert.equal(mock.calls.filter(c => c.path.endsWith('/chat/messages')).length, 2);
    assert.equal(mock.calls.filter(c => c.body.grant_type === 'refresh_token').length, 1);
  } finally { await mock.close(); }
});
test('EventSub subscribes, deduplicates, hands off reconnect and resubscribes after loss', async () => {
  const mock = await twitchMock(); const { auth } = await authorized(mock); let received = 0; let fatal = false;
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10, onFatal: () => { fatal = true; } });
  try {
    await source.start(() => { received++; });
    assert.equal(mock.subscriptions[0].condition.broadcaster_user_id, 'owner');
    assert.deepEqual(mock.subscriptions.map(s => s.type).sort(), ['channel.chat.message', 'channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear'].sort());
    const notice = { metadata: { message_type: 'notification', message_id: 'once' }, payload: {} };
    mock.send(notice); mock.send(notice); await until(() => received === 1);
    mock.send({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: mock.websocketUrl + '?reconnect=1' } } });
    await until(() => mock.peers.length === 2 && mock.peers[0].readyState === 3);
    assert.equal(mock.subscriptions.length, 4);
    mock.peers[1].terminate(); await until(() => mock.subscriptions.length === 8);
    mock.send({ metadata: { message_type: 'revocation' }, payload: { subscription: { status: 'authorization_revoked' } } });
    await until(() => fatal);
  } finally { source.stop(); await mock.close(); }
});
test('welcome deadline reconnects instead of hanging on an idle socket', async () => {
  const mock = await twitchMock(); const { auth } = await authorized(mock); mock.welcome(false);
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10, welcomeTimeoutMs: 40 });
  try {
    const ready = source.start(() => {}); await until(() => mock.peers.length === 1); mock.welcome(true);
    await ready; assert.ok(mock.peers.length >= 2);
  } finally { source.stop(); await mock.close(); }
});
test('live runtime routes mock chat on token channel to operator-approved Helix', async () => {
  const mock = await twitchMock(); const { auth } = await authorized(mock);
  const runtime = liveRuntime(auth, mock.app, { journal: new Journal(), allowActions: true, websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', helixBaseUrl: mock.base + '/helix/' });
  try {
    await runtime.start(0);
    const rows = (await readFile(new URL('../fixtures/chat.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    for (const row of rows) { row.metadata.message_timestamp = new Date().toISOString(); row.payload.event.broadcaster_user_id = 'owner'; mock.send(row); }
    await until(() => Object.keys(runtime.loop.snapshot().current?.votes ?? {}).length === 3);
    const id = runtime.loop.snapshot().current!.id;
    runtime.loop.control('close', id); runtime.loop.control('force-guilty', id);
    await until(() => runtime.loop.engine.get(id).effects?.verdict?.status === 'sent');
    assert.equal(mock.calls.filter(c => c.path.endsWith('/moderation/bans')).length, 1);
  } finally { await runtime.stop(); await mock.close(); }
});
test('hourly validator stops the session when authorization is revoked', async t => {
  const mock = await twitchMock(); const { auth } = await authorized(mock);
  let callback!: () => void; let interval = 0; let stopped = false;
  const original = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', ((fn: () => void, ms: number) => { callback = fn; interval = ms; return original(fn, ms); }) as typeof setInterval);
  try {
    auth.startValidation(() => { stopped = true; });
    assert.equal(interval, 3600000); mock.revoke(); callback();
    await until(() => stopped); await assert.rejects(auth.accessToken(), /authorization/);
  } finally { auth.stopValidation(); await mock.close(); }
});
test('token files are private and are reusable without exposing their values', async t => {
  const { FileTokenStore } = await import('../src/auth.ts');
  const { stat, unlink } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const path = `${process.cwd()}/data-test-${randomUUID()}.jsonl`;
  try {
    const store = new FileTokenStore(path);
    assert.equal(await store.load(), null);
    await store.save({ access_token: 'mock-access', refresh_token: 'mock-refresh', expiresAt: 10000 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await store.load())!.expiresAt, 10000);
  } finally {
    const info = await stat(path).catch(() => null);
    if (info) { await unlink(path); t.diagnostic(`Deleted test file ${JSON.stringify({ size: info.size, path })}`); }
  }
});
test('missed keepalive replaces the connection and creates fresh subscriptions', async () => {
  const mock = await twitchMock(); const { auth } = await authorized(mock); mock.keepalive(0.01);
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10 });
  try {
    await source.start(() => {});
    await until(() => mock.subscriptions.length === 8);
    assert.equal(mock.peers[0].readyState, 3);
  } finally { source.stop(); await mock.close(); }
});
