export interface ModerationActions {
  timeout(caseId: string, userId: string, seconds: number): Promise<void>;
  postVerdict(caseId: string, text: string): Promise<void>;
}
/** Intent recorder for tests and sim. It never sends a Twitch request. */
export class DryRunActions implements ModerationActions {
  readonly intents: Array<{ key: string; userId?: string; seconds?: number; text?: string }> = [];
  async timeout(caseId: string, userId: string, seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('Timeout must be between 1 and 600 seconds');
    const key = `timeout/${caseId}`;
    if (!this.intents.some(i => i.key === key)) this.intents.push({ key, userId, seconds });
  }
  async postVerdict(caseId: string, text: string): Promise<void> {
    const key = `verdict/${caseId}`;
    if (!this.intents.some(i => i.key === key)) this.intents.push({ key, text });
  }
}
