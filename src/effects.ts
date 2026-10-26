import type { CaseEngine, Effect, EffectName } from './case.ts';
import { DryRunHelix, HelixFailure, type HelixClient } from './helix.ts';
export class Effects {
  private engine: CaseEngine;
  readonly client: HelixClient;
  private now: () => number;
  private notify: () => void;
  private work = new Map<string, Promise<void>>();
  constructor(engine: CaseEngine, options: { client?: HelixClient; now: () => number; notify: () => void }) {
    this.engine = engine; this.client = options.client ?? new DryRunHelix(); this.now = options.now; this.notify = options.notify;
    for (const c of engine.list()) for (const [name, e] of Object.entries(c.effects ?? {})) {
      if (e.status === 'pending') engine.effect(c.id, name as EffectName, { ...e, status: 'unknown', detail: 'Process stopped during request. Owner review required' }, Math.max(this.now(), c.updatedAt));
    }
  }
  private async once(id: string, name: EffectName, action: () => Promise<Effect['receipt'] | void>) {
    if (this.engine.get(id).effects?.[name]) return;
    const write = (e: Effect) => { this.engine.effect(id, name, e, Math.max(this.now(), this.engine.get(id).updatedAt)); this.notify(); };
    write({ status: 'pending', mode: this.client.mode });
    try {
      const receipt = await action();
      write({ status: 'sent', mode: this.client.mode, ...(receipt ? { receipt } : {}) });
    } catch (e) {
      write({ status: e instanceof HelixFailure && !e.uncertain ? 'failed' : 'unknown', mode: this.client.mode,
        detail: e instanceof HelixFailure ? e.message : 'Action result unconfirmed. Owner review required' });
    }
  }
  run(id: string): void {
    if (this.work.has(id)) return;
    const job = this.perform(id).finally(() => this.work.delete(id));
    this.work.set(id, job);
  }
  private async perform(id: string) {
    let c = this.engine.get(id);
    if (c.state === 'expired') { await this.once(id, 'verdict', () => this.client.verdict(id, `Overrule case ${id}. Ruling expired. No action.`)); return; }
    if (!c.verdict) return;
    if (c.state !== 'ruling' && !c.effects) return;
    if (c.verdict === 'guilty' && !c.overturned && c.state === 'ruling') {
      await this.once(id, 'timeout', () => {
        if (this.now() >= (c.actionDeadline ?? c.openedAt + 300000)) throw new HelixFailure('Case action deadline passed');
        return this.client.timeout(c.id, c.message.userId, c.timeoutSeconds);
      });
    }
    c = this.engine.get(id);
    if (!c.effects?.verdict) {
      const outcome = c.verdict === 'notguilty' ? 'No action' : c.effects?.timeout?.status === 'sent' ? this.client.mode === 'dry-run' ? 'Dry run timeout recorded' : 'Timeout confirmed' : 'Timeout unconfirmed. Moderator review required';
      await this.once(id, 'verdict', () => this.client.verdict(id, `Overrule case ${id}. ${outcome}. ${Object.keys(c.votes).length} jurors. A mod can file !appeal @${c.message.login} during the two-minute appeal window.`));
    }
    c = this.engine.get(id);
    if (c.state === 'closed' && c.appealed) {
      if (c.overturned && c.effects?.timeout?.status === 'sent' && c.effects.timeout.receipt) {
        const receipt = c.effects.timeout.receipt;
        await this.once(id, 'release', () => this.client.release(id, c.message.userId, receipt));
      }
      c = this.engine.get(id);
      const release = c.effects?.release;
      const result = c.overturned ? `Overturned. ${release?.status === 'sent' ? 'Timeout release confirmed' : c.effects?.timeout ? 'Check timeout status with the moderator' : 'No timeout to remove'}` : 'Original ruling upheld';
      await this.once(id, 'appealVerdict', () => this.client.verdict(`${id}/appeal`, `Overrule case ${id}. Appeal resolved. ${result}.`));
    }
  }
  async flush(): Promise<void> { await Promise.all([...this.work.values()]); }
}
