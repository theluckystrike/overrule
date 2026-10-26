import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppCredentials { client_id: string; client_secret: string; redirect_uri: string }
export interface OAuthProvider {
  authorizationUrl(state: string): Promise<URL>;
  exchange(code: string, state: string): Promise<void>;
  accessToken(): Promise<string>;
}
/** Called only by an explicit future live setup. Importing this file reads nothing. */
export async function loadAppCredentials(): Promise<AppCredentials | null> {
  let text: string;
  try { text = await readFile(join(homedir(), 'yc-w27-work/.secrets/twitch-app.json'), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read Twitch app credentials');
  }
  try {
    const value = JSON.parse(text);
    if (![value.client_id, value.client_secret, value.redirect_uri].every(v => typeof v === 'string' && v.length > 0)) throw new Error();
    if (value.redirect_uri !== 'http://localhost:3000/auth/callback') throw new Error();
    return { client_id: value.client_id, client_secret: value.client_secret, redirect_uri: value.redirect_uri };
  } catch { throw new Error('Invalid Twitch app credentials. Check the local file without logging it'); }
}
export class DisabledOAuth implements OAuthProvider {
  async authorizationUrl(_state: string): Promise<URL> { throw new Error('Live OAuth is not implemented'); }
  async exchange(_code: string, _state: string): Promise<void> { throw new Error('Live OAuth is not implemented'); }
  async accessToken(): Promise<string> { throw new Error('Live OAuth is not implemented'); }
}

// Authorization code flow. Tokens never enter the repository or an HTTP response.
export interface TokenSet { access_token: string; refresh_token: string; expiresAt: number }
export interface TokenStore { load(): Promise<TokenSet | null>; save(tokens: TokenSet): Promise<void> }
export interface Identity { userId: string; login: string; scopes: string[] }
export const REQUIRED_SCOPES = ['user:read:chat', 'user:write:chat', 'moderator:manage:banned_users'];
export class FileTokenStore implements TokenStore {
  private path: string;
  constructor(path = join(homedir(), '.config/overrule/tokens.json')) { this.path = path; }
  async load(): Promise<TokenSet | null> {
    try {
      const { chmod } = await import('node:fs/promises'); await chmod(this.path, 0o600);
      const t = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || !Number.isFinite(t.expiresAt)) throw new Error();
      return t;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Cannot load the local token store'); }
  }
  async save(tokens: TokenSet): Promise<void> {
    const { mkdir, writeFile, rename, chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.new`;
      await writeFile(temp, JSON.stringify(tokens), { mode: 0o600 }); await chmod(temp, 0o600);
      await rename(temp, this.path);
    } catch { throw new Error('Cannot save the local token store'); }
  }
}
export class TwitchOAuth implements OAuthProvider {
  private app: AppCredentials;
  private store: TokenStore;
  private base: string;
  private now: () => number;
  private tokens: TokenSet | null = null;
  private user?: Identity;
  private state?: { value: string; until: number };
  private refreshing?: Promise<void>;
  private lastValidated = 0;
  private timer?: ReturnType<typeof setInterval>;
  private invalid = false;
  constructor(app: AppCredentials, store: TokenStore, options: { baseUrl?: string; now?: () => number } = {}) {
    this.app = app; this.store = store; this.now = options.now ?? Date.now;
    this.base = options.baseUrl ?? 'https://id.twitch.tv/oauth2/';
    const u = new URL(this.base);
    if (this.base !== 'https://id.twitch.tv/oauth2/' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('OAuth endpoint must be Twitch or a local mock');
  }
  async authorizationUrl(state: string): Promise<URL> {
    if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid OAuth state');
    this.state = { value: state, until: this.now() + 600000 };
    const url = new URL('authorize', this.base);
    url.search = new URLSearchParams({ client_id: this.app.client_id, redirect_uri: this.app.redirect_uri, response_type: 'code', scope: REQUIRED_SCOPES.join(' '), state }).toString();
    return url;
  }
  private async grant(params: Record<string, string>): Promise<void> {
    let response: Response;
    try { response = await fetch(new URL('token', this.base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.app.client_id, client_secret: this.app.client_secret, ...params }) }); }
    catch { throw new Error('OAuth service unavailable'); }
    if (!response.ok) { this.invalid = true; throw new Error('OAuth authorization required'); }
    try {
      const body = await response.json() as any;
      if (!body.access_token || !body.refresh_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error();
      this.tokens = { access_token: body.access_token, refresh_token: body.refresh_token, expiresAt: this.now() + body.expires_in * 1000 };
      await this.store.save(this.tokens); this.invalid = false;
    } catch { this.invalid = true; throw new Error('OAuth token response or storage invalid'); }
  }
  async exchange(code: string, state: string): Promise<void> {
    const expected = this.state; this.state = undefined;
    if (!expected || expected.value !== state || this.now() >= expected.until || !code) throw new Error('OAuth state is invalid or expired');
    await this.grant({ grant_type: 'authorization_code', code, redirect_uri: this.app.redirect_uri });
    await this.validate();
  }
  async initialize(): Promise<boolean> {
    this.tokens = await this.store.load();
    if (!this.tokens) return false;
    if (this.tokens.expiresAt <= this.now() + 60000) await this.refresh();
    await this.validate(); return true;
  }
  identity(): Identity { if (!this.user || this.invalid) throw new Error('OAuth authorization required'); return structuredClone(this.user); }
  private async refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.tokens?.refresh_token) throw new Error('OAuth authorization required');
        await this.grant({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token });
      })().finally(() => { this.refreshing = undefined; });
    }
    await this.refreshing;
  }
  async validate(retry = true): Promise<void> {
    if (!this.tokens) throw new Error('OAuth authorization required');
    let response: Response;
    try { response = await fetch(new URL('validate', this.base), { headers: { Authorization: `OAuth ${this.tokens.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(4000) }); }
    catch { this.invalid = true; throw new Error('OAuth validation unavailable'); }
    if (response.status === 401 && retry) { await this.refresh(); return this.validate(false); }
    if (!response.ok) { this.invalid = true; throw new Error('OAuth authorization required'); }
    try {
      const b = await response.json() as any;
      if (b.client_id !== this.app.client_id || typeof b.user_id !== 'string' || !b.user_id || !Array.isArray(b.scopes) || !REQUIRED_SCOPES.every(s => b.scopes.includes(s)) || (this.user && this.user.userId !== b.user_id)) throw new Error();
      this.user = { userId: b.user_id, login: typeof b.login === 'string' ? b.login : b.user_id, scopes: b.scopes };
      this.invalid = false; this.lastValidated = this.now();
    } catch { this.invalid = true; throw new Error('OAuth identity or scopes do not match'); }
  }
  async accessToken(): Promise<string> {
    if (this.invalid || !this.tokens) throw new Error('OAuth authorization required');
    if (this.tokens.expiresAt <= this.now() + 60000) { await this.refresh(); await this.validate(); }
    if (!this.user || this.now() - this.lastValidated >= 3600000) await this.validate();
    return this.tokens!.access_token;
  }
  async refreshAfter401(rejectedToken: string): Promise<void> {
    if (this.tokens?.access_token === rejectedToken) await this.refresh();
    await this.validate();
  }
  startValidation(onFailure: () => void): void {
    this.stopValidation();
    this.timer = setInterval(() => { void this.validate().catch(() => { this.stopValidation(); onFailure(); }); }, 3600000);
    this.timer.unref();
  }
  stopValidation(): void { if (this.timer) clearInterval(this.timer); }
}
