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
