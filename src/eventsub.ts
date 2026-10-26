import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
export type EventHandler = (event: unknown) => void | Promise<void>;
export interface ChatSource {
  start(handler: EventHandler, signal?: AbortSignal): Promise<void>;
  stop(): void;
}
/** Fixture transport. No credential loading or network access. */
export class FakeEventSub implements ChatSource {
  private file: string | URL;
  private stopped = false;
  constructor(file: string | URL) { this.file = file; }
  async start(handler: EventHandler, signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    const lines = (await readFile(this.file, 'utf8')).split('\n').filter(Boolean);
    for (const [index, line] of lines.entries()) {
      if (this.stopped || signal?.aborted) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new Error(`Invalid fixture line ${index + 1}`); }
      await handler(event);
    }
  }
  stop(): void { this.stopped = true; }
}
export interface LiveEventSubOptions {
  broadcasterId: string; userId: string; clientId: string;
  token: () => Promise<string>; refreshAfter401?: (token: string) => Promise<void>;
  websocketUrl?: string; subscriptionUrl?: string; types?: string[];
  onFatal?: () => void; onStatus?: (status: string) => void;
  reconnectDelayMs?: number; welcomeTimeoutMs?: number;
}
export class LiveEventSub implements ChatSource {
  private options?: LiveEventSubOptions;
  private active?: WebSocket;
  private sockets = new Set<WebSocket>();
  private timers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private seen = new Map<string, number>();
  constructor(options?: LiveEventSubOptions) { this.options = options; }
  async start(handler: EventHandler, signal?: AbortSignal): Promise<void> {
    if (!this.options) throw new Error('Live EventSub requires OAuth configuration');
    if (!this.stopped) throw new Error('EventSub already started');
    const o = this.options;
    const initial = new URL(o.websocketUrl ?? 'wss://eventsub.wss.twitch.tv/ws');
    const local = initial.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(initial.hostname);
    if (!local && !(initial.protocol === 'wss:' && initial.hostname === 'eventsub.wss.twitch.tv')) throw new Error('Invalid EventSub endpoint');
    const endpoint = o.subscriptionUrl ?? 'https://api.twitch.tv/helix/eventsub/subscriptions';
    const api = new URL(endpoint);
    if (endpoint !== 'https://api.twitch.tv/helix/eventsub/subscriptions' && !(local && api.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(api.hostname))) throw new Error('Invalid subscription endpoint');
    this.stopped = false;
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    if (signal?.aborted) { this.stop(); return; }
    let settled = false;
    let queue = Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const fail = () => { if (this.stopped) return; this.stop(); o.onStatus?.('disconnected'); if (!settled) { settled = true; reject(new Error('EventSub authorization or transport failed')); } o.onFatal?.(); };
      const subscribe = async (sessionId: string) => {
        for (const type of o.types ?? ['channel.chat.message', 'channel.chat.message_delete', 'channel.chat.clear_user_messages', 'channel.chat.clear']) {
          let token = await o.token();
          const request = () => fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Authorization: `Bearer ${token}`, 'Client-Id': o.clientId, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, version: '1', condition: { broadcaster_user_id: o.broadcasterId, user_id: o.userId }, transport: { method: 'websocket', session_id: sessionId } }) });
          let response = await request();
          if (response.status === 401 && o.refreshAfter401) { await o.refreshAfter401(token); token = await o.token(); response = await request(); }
          if (response.status !== 202) throw new Error('Subscription rejected');
        }
      };
      const reconnect = () => {
        if (this.stopped || this.retry) return;
        o.onStatus?.('reconnecting');
        this.retry = setTimeout(() => { this.retry = undefined; connect(initial.href, false); }, o.reconnectDelayMs ?? 1000);
      };
      const connect = (url: string, transferred: boolean) => {
        if (this.stopped) return;
        const target = new URL(url);
        if (target.origin !== initial.origin) { fail(); return; }
        const old = this.active;
        const ws = new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: o.welcomeTimeoutMs ?? 10000 });
        this.sockets.add(ws);
        let welcomed = false; let keepalive = 10000;
        const watch = (ms: number) => {
          const prior = this.timers.get(ws); if (prior) clearTimeout(prior);
          this.timers.set(ws, setTimeout(() => { ws.terminate(); }, ms));
        };
        watch(o.welcomeTimeoutMs ?? 10000);
        ws.on('message', data => {
          queue = queue.then(async () => {
            if (this.stopped) return;
            const value = JSON.parse(data.toString());
            const kind = value.metadata?.message_type;
            if (kind === 'session_welcome') {
              if (welcomed || typeof value.payload?.session?.id !== 'string') throw new Error();
              welcomed = true;
              const seconds = value.payload.session.keepalive_timeout_seconds;
              keepalive = typeof seconds === 'number' && seconds > 0 ? seconds * 1000 + 1000 : 15000;
              watch(keepalive);
              if (!transferred) await subscribe(value.payload.session.id);
              if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
              this.active = ws;
              if (old && old !== ws) old.close();
              o.onStatus?.('connected');
              if (!settled) { settled = true; resolve(); }
            } else if (kind === 'session_reconnect') {
              if (ws !== this.active || typeof value.payload?.session?.reconnect_url !== 'string') return;
              watch(30000); connect(value.payload.session.reconnect_url, true);
            } else if (kind === 'revocation') { fail(); }
            else if (welcomed && (kind === 'session_keepalive' || kind === 'notification')) {
              watch(keepalive);
              if (kind === 'notification') {
                const id = value.metadata?.message_id;
                if (typeof id !== 'string') throw new Error();
                for (const [key, at] of this.seen) if (Date.now() - at > 600000) this.seen.delete(key);
                if (this.seen.has(id)) return;
                this.seen.set(id, Date.now());
                if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!);
                await handler(value);
              }
            }
          }).catch(fail);
        });
        ws.on('error', () => { /* Close drives reconnect. Never log a URL with reconnect tokens. */ });
        ws.on('close', (code) => {
          const timer = this.timers.get(ws); if (timer) clearTimeout(timer);
          this.timers.delete(ws); this.sockets.delete(ws);
          if (this.stopped) return;
          if (code === 4001 || code === 4003) { fail(); return; }
          if (ws === this.active || !welcomed) { if (ws === this.active) this.active = undefined; reconnect(); }
        });
      };
      connect(initial.href, false);
    });
  }
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear(); this.active = undefined;
  }
}
