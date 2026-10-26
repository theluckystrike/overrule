import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { REQUIRED_SCOPES, type TokenStore, type TokenSet } from '../../src/auth.ts';
export class MemoryTokens implements TokenStore {
  value: TokenSet | null = null;
  async load() { return this.value; }
  async save(t: TokenSet) { this.value = structuredClone(t); }
}
export async function twitchMock() {
  const calls: Array<{ path: string; method: string; body: any; authorization?: string }> = [];
  const faults = new Map<string, Array<number | 'timeout' | 'close' | 'body-timeout'>>();
  let keepalive = 10;
  let access = 'mock-access-1'; let generation = 1; let scopes = [...REQUIRED_SCOPES]; let revoke = false; let welcome = true;
  const peers: WebSocket[] = []; const subscriptions: any[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: url.pathname, method: req.method!, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    const fault = faults.get(url.pathname)?.shift();
    if (fault === 'timeout') return;
    if (fault === 'body-timeout') { res.writeHead(200); res.write('{'); return; }
    if (fault === 'close') { peers.at(-1)?.terminate(); res.writeHead(202); res.end('{}'); return; }
    if (typeof fault === 'number') { res.writeHead(fault); res.end('{}'); return; }
    if (url.pathname === '/oauth2/token') {
      if (revoke) { res.writeHead(400); res.end('{}'); return; }
      access = `mock-access-${++generation}`;
      res.end(JSON.stringify({ access_token: access, refresh_token: 'mock-refresh', expires_in: 7200 })); return;
    }
    if (url.pathname === '/oauth2/validate') {
      if (revoke || req.headers.authorization !== `OAuth ${access}`) { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify({ client_id: 'mock-client', user_id: 'owner', login: 'owner', scopes, expires_in: 7200 })); return;
    }
    if (req.headers.authorization !== `Bearer ${access}`) { res.writeHead(401); res.end('{}'); return; }
    if (url.pathname.endsWith('/eventsub/subscriptions')) { subscriptions.push(body); res.writeHead(202); res.end(JSON.stringify({ data: [{ id: 'sub', status: 'enabled' }] })); return; }
    if (url.pathname.endsWith('/moderation/bans')) { res.end(JSON.stringify({ data: [{ user_id: body.data.user_id, broadcaster_id: 'owner', moderator_id: 'owner', created_at: new Date().toISOString(), end_time: new Date(Date.now() + 600000).toISOString() }] })); return; }
    if (url.pathname.endsWith('/chat/messages')) { res.end(JSON.stringify({ data: [{ message_id: 'sent', is_sent: true }] })); return; }
    res.writeHead(404); res.end('{}');
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', peer => { peers.push(peer); if (welcome) peer.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: `session-${peers.length}`, keepalive_timeout_seconds: keepalive } } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (value: unknown) => peers.at(-1)!.send(JSON.stringify(value));
  return { base, websocketUrl: base.replace('http:', 'ws:') + '/ws', calls, peers, subscriptions, send,
    app: { client_id: 'mock-client', client_secret: 'mock-secret', redirect_uri: 'http://localhost:3000/auth/callback' },
    fault: (path: string, ...values: Array<number | 'timeout' | 'close' | 'body-timeout'>) => { faults.set(path, values); },
    keepalive: (seconds: number) => { keepalive = seconds; },
    expire: () => { access = 'expired'; }, revoke: () => { revoke = true; }, scopes: (s: string[]) => { scopes = s; }, welcome: (v: boolean) => { welcome = v; },
    close: () => { for (const peer of peers) peer.terminate(); ws.close(); server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); } };
}
export async function until(check: () => boolean, limit = 3000) { const start = Date.now(); while (!check()) { if (Date.now() - start > limit) throw new Error('Mock deadline exceeded'); await new Promise(r => setTimeout(r, 10)); } }
