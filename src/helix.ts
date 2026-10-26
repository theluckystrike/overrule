import { loadAppCredentials, type OAuthProvider } from './auth.ts';
export interface TimeoutReceipt { createdAt: string; endsAt: string; reason: string }
export interface HelixClient {
  readonly mode: 'dry-run' | 'fake' | 'live';
  timeout(caseId: string, userId: string, seconds: number): Promise<TimeoutReceipt>;
  verdict(caseId: string, message: string): Promise<void>;
  release(caseId: string, userId: string, receipt: TimeoutReceipt): Promise<void>;
}
export class HelixFailure extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export class DryRunHelix implements HelixClient {
  readonly mode = 'dry-run' as const;
  readonly calls: string[] = [];
  async timeout(caseId: string, _userId: string, seconds: number): Promise<TimeoutReceipt> {
    checkDuration(seconds); this.calls.push(`timeout/${caseId}`);
    return { createdAt: new Date().toISOString(), endsAt: new Date(Date.now() + seconds * 1000).toISOString(), reason: `Overrule case ${caseId}` };
  }
  async verdict(caseId: string, _message: string): Promise<void> { this.calls.push(`verdict/${caseId}`); }
  async release(caseId: string, _userId: string, _receipt: TimeoutReceipt): Promise<void> { this.calls.push(`release/${caseId}`); }
}
function checkDuration(seconds: number) { if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new HelixFailure('Timeout must be between 1 and 600 seconds'); }
interface Options { baseUrl?: string; clientId: string; token: () => Promise<string>; refreshAfter401?: (token: string) => Promise<void>; broadcasterId: string; moderatorId: string; liveEnabled?: boolean; timeoutMs?: number }
export class HttpHelix implements HelixClient {
  readonly mode: 'fake' | 'live';
  private options: Options;
  private base: URL;
  constructor(options: Options) {
    this.options = options; this.base = new URL(options.baseUrl ?? 'https://api.twitch.tv/helix/');
    const live = this.base.href === 'https://api.twitch.tv/helix/';
    const local = this.base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(this.base.hostname) && this.base.pathname === '/helix/';
    if (!live && !local) throw new Error('Helix endpoint must be Twitch or a local fake server');
    if (live && !options.liveEnabled) throw new Error('OWNER-NEEDED. Live Helix gate is closed');
    this.mode = live ? 'live' : 'fake';
  }
  private async authorize(work: () => Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization deadline')), this.options.timeoutMs ?? 4000);
      })]);
    } catch { throw new HelixFailure('Not sent. Authorization unavailable'); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async request(method: string, path: string, query: Record<string, string>, body?: unknown): Promise<any> {
    const url = new URL(path, this.base); url.search = new URLSearchParams(query).toString();
    let token = await this.authorize(() => this.options.token());
    try {
      const request = () => fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000),
        headers: { 'Client-Id': this.options.clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      let response = await request();
      if (response.status === 401 && this.options.refreshAfter401) {
        token = await this.authorize(async () => { await this.options.refreshAfter401!(token); return this.options.token(); }); response = await request();
      }
      if (!response.ok) throw new HelixFailure(`Helix request rejected with HTTP ${response.status}`, response.status >= 500);
      if (response.status === 204) return null;
      return await response.json();
    } catch (e) { if (e instanceof HelixFailure) throw e; throw new HelixFailure('Helix result is unconfirmed. Check the channel before another action', true); }
  }
  private query() { return { broadcaster_id: this.options.broadcasterId, moderator_id: this.options.moderatorId }; }
  async timeout(caseId: string, userId: string, seconds: number): Promise<TimeoutReceipt> {
    checkDuration(seconds);
    const reason = `Overrule case ${caseId}`;
    const result = await this.request('POST', 'moderation/bans', this.query(), { data: { user_id: userId, duration: seconds, reason } });
    const row = result?.data?.[0];
    if (row?.user_id !== userId || row?.broadcaster_id !== this.options.broadcasterId || row?.moderator_id !== this.options.moderatorId || !Number.isFinite(Date.parse(row?.created_at)) || !Number.isFinite(Date.parse(row?.end_time))) throw new HelixFailure('Timeout receipt is unconfirmed', true);
    return { createdAt: row.created_at, endsAt: row.end_time, reason };
  }
  async verdict(_caseId: string, message: string): Promise<void> {
    if (!message || message.length > 500) throw new HelixFailure('Verdict message exceeds the local limit');
    const result = await this.request('POST', 'chat/messages', {}, { broadcaster_id: this.options.broadcasterId, sender_id: this.options.moderatorId, message });
    if (result?.data?.[0]?.is_sent === false) throw new HelixFailure('Twitch dropped the verdict message');
    if (result?.data?.[0]?.is_sent !== true || typeof result?.data?.[0]?.message_id !== 'string') throw new HelixFailure('Verdict delivery is unconfirmed', true);
  }
  async release(_caseId: string, userId: string, receipt: TimeoutReceipt): Promise<void> {
    const result = await this.request('GET', 'moderation/banned', { broadcaster_id: this.options.broadcasterId, user_id: userId });
    if (!Array.isArray(result?.data)) throw new HelixFailure('Cannot confirm the current timeout');
    const ban = result.data.find((b: any) => b.user_id === userId);
    if (!ban) return; // Already expired or removed. Never create a new action.
    if (!ban.expires_at || ban.created_at !== receipt.createdAt || ban.expires_at !== receipt.endsAt || ban.reason !== receipt.reason || ban.moderator_id !== this.options.moderatorId) throw new HelixFailure('Timeout changed outside this case. Owner review required');
    await this.request('DELETE', 'moderation/bans', { ...this.query(), user_id: userId });
  }
}
/** No file is read unless the caller explicitly opens the live gate. */
export async function createLiveHelix(options: { oauth: OAuthProvider; broadcasterId: string; moderatorId: string; ownerGate?: boolean }): Promise<HelixClient | null> {
  if (!options.ownerGate) throw new Error('OWNER-NEEDED. Live Helix gate is closed');
  if (options.broadcasterId !== options.moderatorId) throw new Error('This live adapter requires the broadcaster token for timeout ownership checks');
  const app = await loadAppCredentials();
  if (!app) return null;
  return new HttpHelix({ clientId: app.client_id, token: () => options.oauth.accessToken(), broadcasterId: options.broadcasterId, moderatorId: options.moderatorId, liveEnabled: true });
}
