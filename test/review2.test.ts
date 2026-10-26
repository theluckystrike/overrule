import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalize, Ingest } from '../src/ingest.ts';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
import { TwitchOAuth } from '../src/auth.ts';
import { liveRuntime } from '../src/live.ts';
import { LiveEventSub } from '../src/eventsub.ts';
import { twitchMock, MemoryTokens, until } from './helpers/twitch-mock.ts';
function chat(id: string, user: string, text: string, badge = '') {
  return normalize({ metadata: { message_id: id, message_type: 'notification', message_timestamp: new Date(1000).toISOString() }, payload: { subscription: { type: 'channel.chat.message' }, event: { broadcaster_user_id: 'channel', chatter_user_id: user, chatter_user_login: user, message_id: id, message: { text }, badges: [{ set_id: badge }] } } })!;
}
async function authorize(mock: Awaited<ReturnType<typeof twitchMock>>) {
  const store = new MemoryTokens(); const auth = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/' });
  await auth.authorizationUrl('a'.repeat(64)); await auth.exchange('mock-code', 'a'.repeat(64)); return { auth, store };
}
test('N1 lead moderator badge grants immunity, mod commands, proxy appeal and weight three', () => {
  const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'channel');
  const lead = chat('lead', 'lead', 'hello', 'lead_moderator');
  assert.equal(lead.role, 'moderator'); ingest.accept(lead, 1000);
  assert.equal(ingest.accept(chat('trial', 'mod', '!case @lead Spam', 'moderator'), 1000).ok, false);
  ingest.accept(chat('alt', 'alt', 'spam'), 1000);
  assert.equal(ingest.accept(chat('open', 'lead', '!case @alt Spam', 'lead_moderator'), 1000).ok, true);
  const id = engine.list()[0].id;
  ingest.accept(chat('vote', 'lead', '!guilty', 'lead_moderator'), 1000); assert.equal(engine.get(id).votes.lead.weight, 3);
  engine.advance('end', id, 'awaiting_approval', 1000); engine.decide('g', id, 'guilty', true, 1000); engine.advance('appeal', id, 'appeal_window', 1000);
  assert.equal(ingest.accept(chat('proxy', 'lead', '!appeal @alt', 'lead_moderator'), 1000).ok, true);
});
test('N1 staff, admin and global moderator badges are immune', () => {
  for (const badge of ['staff', 'admin', 'global_mod']) {
    const engine = new CaseEngine(new Journal(), 's'); const ingest = new Ingest(engine, 'channel');
    ingest.accept(chat('target', 'target', 'hello', badge), 1000);
    assert.equal(ingest.accept(chat('trial', 'mod', '!case @target Spam', 'moderator'), 1000).ok, false, badge);
  }
});
test('N2 authorization forces account choice and expected login rejects a stored wrong account', async () => {
  const mock = await twitchMock();
  try {
    const { auth, store } = await authorize(mock);
    assert.equal((await auth.authorizationUrl('b'.repeat(64))).searchParams.get('force_verify'), 'true');
    const restored = new TwitchOAuth(mock.app, store, { baseUrl: mock.base + '/oauth2/' }); await restored.initialize();
    const previous = process.env.OVERRULE_EXPECTED_LOGIN;
    try {
      process.env.OVERRULE_EXPECTED_LOGIN = 'different-channel';
      assert.throws(() => liveRuntime(restored, mock.app, { journal: new Journal() }), /expected channel/i);
    } finally { if (previous === undefined) delete process.env.OVERRULE_EXPECTED_LOGIN; else process.env.OVERRULE_EXPECTED_LOGIN = previous; }
  } finally { await mock.close(); }
});
test('N3 owner instructions forbid deletion of the timeout target and explain expiry', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const script = await readFile(new URL('../docs/owner-test.md', import.meta.url), 'utf8');
  assert.match(readme, /Do not delete the target message/); assert.match(script, /Do not delete the target message/);
  assert.match(readme, /deleted evidence.*expired/i);
});
test('N5 one validate 503 retries without poisoning authorization', async () => {
  const mock = await twitchMock();
  try { const { auth } = await authorize(mock); mock.fault('/oauth2/validate', 503); await auth.validate(); assert.equal(auth.identity().login, 'owner'); assert.ok(await auth.accessToken()); }
  finally { await mock.close(); }
});
test('N5 one subscription timeout reconnects without a fatal session stop', async () => {
  const mock = await twitchMock(); const { auth } = await authorize(mock); let fatal = false;
  mock.fault('/eventsub/subscriptions', 'timeout');
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10, onFatal: () => { fatal = true; } });
  try { await source.start(() => {}); assert.equal(fatal, false); assert.ok(mock.peers.length >= 2); assert.equal(mock.subscriptions.length, 4); }
  finally { source.stop(); auth.stopValidation(); await mock.close(); }
});
test('N6 socket loss between welcome and subscription completion reconnects', async () => {
  const mock = await twitchMock(); const { auth } = await authorize(mock);
  mock.fault('/eventsub/subscriptions', 'close');
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 10 });
  try { const started = source.start(() => {}); await until(() => mock.peers.length >= 2); await started; assert.ok(mock.subscriptions.length >= 4); }
  finally { source.stop(); auth.stopValidation(); await mock.close(); }
});
test('N5 hourly validation retries a 503 and only authorization errors stop it', async t => {
  const mock = await twitchMock(); const { auth } = await authorize(mock); let callback!: () => void; let fatal = false;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', ((fn: () => void, ms: number) => { callback = fn; return interval(fn, ms); }) as typeof setInterval);
  try {
    auth.startValidation(() => { fatal = true; }); mock.fault('/oauth2/validate', 503); callback();
    await until(() => mock.calls.filter(c => c.path.endsWith('/validate')).length === 2);
    assert.equal(auth.identity().login, 'owner');
    await until(() => mock.calls.filter(c => c.path.endsWith('/validate')).length === 3);
    assert.equal(fatal, false); assert.ok(await auth.accessToken());
  } finally { auth.stopValidation(); await mock.close(); }
});
test('N5 token refresh retries 429 and 503 but rejects revoked authorization', async () => {
  const mock = await twitchMock(); const { auth } = await authorize(mock);
  try {
    const token = await auth.accessToken(); mock.fault('/oauth2/token', 429, 503);
    await auth.refreshAfter401(token); assert.ok(await auth.accessToken());
    assert.equal(mock.calls.filter(c => c.body.grant_type === 'refresh_token').length, 3);
    mock.revoke(); await assert.rejects(auth.validate(), /authorization/); await assert.rejects(auth.accessToken(), /authorization/);
  } finally { auth.stopValidation(); await mock.close(); }
});
test('N5 retry delay doubles and caps at one minute', async () => {
  const { retryDelay } = await import('../src/auth.ts');
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => retryDelay(i)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});
test('N10 token test teardown does not depend on the build machine directory', async () => {
  const source = await readFile(new URL('./live.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/Users\/|sprint-1026-work|DELETIONS-MANIFEST/);
});
test('N15 unavailable or slow authorization records not sent and cannot later send a timeout', async () => {
  const { HttpHelix, HelixFailure } = await import('../src/helix.ts');
  const mock = await twitchMock();
  try {
    for (const token of [async () => { throw new Error('unavailable'); }, async () => { await new Promise(r => setTimeout(r, 60)); return 'mock-access-1'; }]) {
      const helix = new HttpHelix({ baseUrl: mock.base + '/helix/', clientId: mock.app.client_id, broadcasterId: 'owner', moderatorId: 'owner', token, timeoutMs: 20 });
      await assert.rejects(helix.timeout('case', 'alt', 60), e => e instanceof HelixFailure && !e.uncertain && /Not sent. Authorization unavailable/.test(e.message));
    }
    await new Promise(r => setTimeout(r, 80)); assert.equal(mock.calls.length, 0);
  } finally { await mock.close(); }
});
test('N7 reconnect backoff doubles and resets after a successful connection', async t => {
  const mock = await twitchMock(); const { auth } = await authorize(mock); mock.welcome(false);
  const delays: number[] = []; const schedule = globalThis.setTimeout;
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(globalThis, 'setTimeout', ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => { if (ms !== undefined) delays.push(ms); return schedule(fn, ms, ...args); }) as typeof setTimeout);
  const source = new LiveEventSub({ broadcasterId: 'owner', userId: 'owner', clientId: mock.app.client_id, token: () => auth.accessToken(), websocketUrl: mock.websocketUrl, subscriptionUrl: mock.base + '/eventsub/subscriptions', reconnectDelayMs: 50, welcomeTimeoutMs: 30 });
  try {
    const started = source.start(() => {}); await until(() => mock.peers.length >= 2); mock.welcome(true); await started;
    assert.ok(delays.includes(50)); assert.ok(delays.includes(100));
    delays.length = 0; mock.peers.at(-1)!.terminate(); await until(() => mock.subscriptions.length === 8);
    assert.ok(delays.includes(50)); assert.equal(delays.includes(100), false);
  } finally { source.stop(); auth.stopValidation(); await mock.close(); }
});

test('N5 a stalled validation response body retries without invalidating the user', async () => {
  const mock = await twitchMock(); const { auth } = await authorize(mock);
  try { mock.fault('/oauth2/validate', 'body-timeout'); await auth.validate(); assert.equal(auth.identity().login, 'owner'); }
  finally { auth.stopValidation(); await mock.close(); }
});
