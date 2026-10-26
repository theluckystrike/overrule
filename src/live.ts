import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadAppCredentials, TwitchOAuth, FileTokenStore, type AppCredentials } from './auth.ts';
import { LiveEventSub } from './eventsub.ts';
import { VoteLoop } from './loop.ts';
import { Journal } from './precedent.ts';
import { DryRunHelix, HttpHelix } from './helix.ts';
import { createApp } from './server.ts';
import { configuredBrain } from './brain.ts';

export class ChannelSelectionError extends Error {}
function expectedLogin(allowActions: boolean): string | undefined {
  const expected = process.env.OVERRULE_EXPECTED_LOGIN?.trim().toLowerCase();
  if (allowActions && !expected) throw new ChannelSelectionError('OVERRULE_EXPECTED_LOGIN is required when real actions are enabled');
  if (expected && !/^[a-z0-9_]{1,25}$/.test(expected)) throw new ChannelSelectionError('OVERRULE_EXPECTED_LOGIN must be a Twitch login');
  return expected || undefined;
}
function checkIdentity(auth: TwitchOAuth, expected?: string): void {
  const login = auth.identity().login;
  if (expected && login.toLowerCase() !== expected) throw new ChannelSelectionError(`Authorized login ${login} does not match expected ${expected}`);
}
export async function prepareAuthorization(auth: TwitchOAuth, expected?: string): Promise<boolean> {
  try {
    if (!await auth.initialize()) return false;
    checkIdentity(auth, expected); return true;
  } catch (error) {
    console.log(error instanceof ChannelSelectionError ? error.message : 'Stored authorization needs renewal.');
    auth.discardAuthorization(); return false;
  }
}
export function authorizationServer(auth: TwitchOAuth, expected?: string) {
  let completed!: () => void;
  const authorized = new Promise<void>(resolve => { completed = resolve; });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    const address = server.address(); const port = address && typeof address !== 'string' ? address.port : 3000;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host ?? '')) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    try {
      if (url.pathname === '/auth') {
        const state = randomBytes(32).toString('hex');
        const target = await auth.authorizationUrl(state);
        res.setHeader('Set-Cookie', `overrule_state=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`);
        res.writeHead(302, { Location: target.href }); res.end();
      } else if (url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state') ?? '';
        const cookie = /(?:^|;\s*)overrule_state=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (!cookie || cookie !== state || url.searchParams.has('error')) throw new Error();
        await auth.exchange(url.searchParams.get('code') ?? '', state);
        checkIdentity(auth, expected);
        res.setHeader('Set-Cookie', 'overrule_state=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');
        res.end('Twitch authorization complete. Open the operator page after the terminal reports connected.');
        completed();
      } else if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><title>Overrule authorization</title><h1>Connect the broadcaster test account</h1><a href="/auth">Authorize Twitch</a><p>No token is shown on this page.</p>');
      } else { res.writeHead(404); res.end(); }
    } catch (error) {
      if (error instanceof ChannelSelectionError) { console.log(error.message); auth.discardAuthorization(); }
      res.writeHead(400); res.end(error instanceof ChannelSelectionError ? error.message : 'Authorization failed. Restart authorization from the local home page.');
    }
  });
  return { server, authorized };
}
export function liveRuntime(auth: TwitchOAuth, credentials: AppCredentials, options: {
  journal?: Journal; allowActions?: boolean; websocketUrl?: string; subscriptionUrl?: string; helixBaseUrl?: string;
} = {}) {
  const expected = expectedLogin(options.allowActions ?? false);
  checkIdentity(auth, expected);
  const identity = auth.identity();
  const id = identity.userId;
  const helix = options.allowActions ? new HttpHelix({ clientId: credentials.client_id, token: () => auth.accessToken(), refreshAfter401: token => auth.refreshAfter401(token), broadcasterId: id, moderatorId: id, liveEnabled: true, baseUrl: options.helixBaseUrl }) : new DryRunHelix();
  const loop = new VoteLoop({ liveSource: true, vipImmune: process.env.VIP_IMMUNITY !== '0', subscribersOnly: process.env.SUBSCRIBER_VOTES_ONLY === '1', channelId: id, streamId: `live-${id}-${new Date().toISOString().slice(0, 10)}`, journal: options.journal ?? new Journal('data/live-audit.jsonl'), helix, brain: configuredBrain() });
  const app = createApp(loop, { live: true });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { auth.stopValidation(); source.stop(); await app.stop().catch(() => {}); await loop.flush(); loop.dispose(); })();
  const source = new LiveEventSub({ broadcasterId: id, userId: id, clientId: credentials.client_id, token: () => auth.accessToken(), refreshAfter401: token => auth.refreshAfter401(token), websocketUrl: options.websocketUrl, subscriptionUrl: options.subscriptionUrl,
    onFatal: () => { console.error('Live session stopped. Reauthorize before continuing.'); void stop(); }, onStatus: status => console.log(`EventSub ${status}`) });
  return { loop, app, source, stop, start: async (port = 3000) => {
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
    auth.startValidation(() => { console.error('OAuth validation failed. Live session stopped.'); void stop(); });
    await source.start(raw => { try { loop.accept(raw); } catch { console.log('Chat event ignored by court rules'); } });
    console.log(`Connected to channel ${identity.login}`);
  } };
}
export async function startLive(): Promise<void> {
  const allowActions = process.env.DRY_RUN === '0' && process.env.OVERRULE_LIVE_ACTIONS === '1';
  const expected = expectedLogin(allowActions);
  const credentials = await loadAppCredentials();
  if (!credentials) throw new Error('OWNER-NEEDED. Save the Twitch app credentials before starting live mode');
  const auth = new TwitchOAuth(credentials, new FileTokenStore());
  const ready = await prepareAuthorization(auth, expected);
  if (!ready) {
    const gate = authorizationServer(auth, expected);
    await new Promise<void>((resolve, reject) => { gate.server.once('error', reject); gate.server.listen(3000, '127.0.0.1', resolve); });
    console.log('OWNER-NEEDED. Open http://localhost:3000 and authorize the broadcaster test account.');
    await gate.authorized;
    await new Promise<void>(resolve => gate.server.close(() => resolve()));
  }
  const runtime = liveRuntime(auth, credentials, { allowActions });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void runtime.stop(); });
  await runtime.start();
  console.log(allowActions ? 'Live actions enabled by owner. Operator approval is required.' : 'Live chat connected. Actions remain dry runs.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startLive().catch(error => { console.error(error instanceof ChannelSelectionError ? error.message : 'Live startup failed. Check local app setup and authorization without printing credentials.'); process.exitCode = 1; });
