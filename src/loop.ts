import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CaseEngine } from './case.ts';
import { Journal, consistency } from './precedent.ts';
import { Ingest, normalize } from './ingest.ts';
import { Brain } from './brain.ts';
import { Effects } from './effects.ts';
import type { HelixClient } from './helix.ts';

export type Control = 'close' | 'approve' | 'veto' | 'demo-appeal' | 'uphold' | 'overturn';
export class VoteLoop extends EventEmitter {
  readonly engine: CaseEngine;
  readonly autoApprove: boolean;
  readonly now: () => number;
  private ingest: Ingest;
  private pending?: { id: string; veto: boolean; at: number };
  private revision = 0;
  readonly effects: Effects;
  private brain: Brain;
  private analyses = new Set<Promise<void>>();
  replaying = false;
  constructor(options: { journal?: Journal; now?: () => number; autoApprove?: boolean; helix?: HelixClient; brain?: Brain; channelId?: string; streamId?: string } = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.autoApprove = options.autoApprove ?? false;
    this.engine = new CaseEngine(options.journal ?? new Journal(), options.streamId ?? randomUUID());
    this.ingest = new Ingest(this.engine, options.channelId ?? 'channel-test');
    this.brain = options.brain ?? new Brain();
    this.effects = new Effects(this.engine, { client: options.helix, now: this.now, notify: () => this.publish() });
  }
  snapshot() {
    const cases = this.engine.list();
    const current = cases.find(c => c.state !== 'closed') ?? cases.at(-1) ?? null;
    return { revision: this.revision, now: this.now(), cases, current, gavel: current?.state === 'ruling',
      pending: this.pending ? { veto: this.pending.veto } : null,
      autoApprove: this.autoApprove, actionMode: this.effects.client.mode, replaying: this.replaying, consistency: consistency(cases) };
  }
  publish(): void { this.revision++; this.emit('snapshot', this.snapshot()); }
  accept(raw: unknown): void {
    const event = normalize(raw);
    if (!event) throw new Error('Invalid fixture event');
    const result = this.ingest.accept(event, this.now());
    if (!result.ok) throw new Error(result.detail);
    for (const c of this.engine.list().filter(c => !c.analysis && c.state === 'voting')) {
      this.engine.annotate(c.id, this.brain.fallback(c, this.engine.list()), this.now());
      const job = this.brain.analyze(c, this.engine.list()).then(analysis => {
        if (analysis.source === 'model') this.engine.annotate(c.id, analysis, Math.max(this.now(), this.engine.get(c.id).updatedAt));
        this.publish();
      }).finally(() => this.analyses.delete(job));
      this.analyses.add(job);
    }
    this.publish();
  }
  control(action: Control, id: string): void {
    const current = this.snapshot().current;
    if (!current || current.id !== id) throw new Error('Stale case. Wait for the current card');
    if (action === 'demo-appeal') {
      if (this.effects.client.mode === 'live') throw new Error('Live appeals must come from the accused in chat');
      this.engine.appeal(`demo-appeal-${id}`, id, current.message.userId, this.now()); this.publish(); return;
    }
    if (action === 'uphold' || action === 'overturn') {
      this.engine.resolveAppeal(`appeal-decision-${id}`, id, action === 'overturn', true, this.now());
      this.effects.run(id); this.publish(); return;
    }
    if (action === 'close') {
      if (current.state !== 'voting') return;
      this.engine.advance(`space-${id}`, id, 'awaiting_approval', this.now());
    } else {
      if (current.state !== 'awaiting_approval') throw new Error('Close voting before a decision');
      // A short arbitration window lets V win over A in the same input burst.
      if (!this.pending) this.pending = { id, veto: action === 'veto', at: this.now() + 300 };
      else this.pending.veto ||= action === 'veto';
    }
    this.publish();
  }
  tick(): void {
    const now = this.now();
    this.engine.tick(now);
    const c = this.snapshot().current;
    if (c?.state === 'awaiting_approval' && this.autoApprove && !this.pending && now >= c.updatedAt + 1500) this.control('approve', c.id);
    if (this.pending && now >= this.pending.at) {
      const p = this.pending; const current = this.engine.get(p.id);
      const verdict = p.veto ? 'notguilty' : current.jury ?? 'guilty';
      // A delayed demo must not make an old-message timeout intent.
      this.engine.decide(`operator-${p.id}`, p.id, now - current.message.at > 120000 ? 'notguilty' : verdict, true, now);
      this.pending = undefined;
    }
    for (const item of this.engine.list()) {
      if (item.state === 'ruling' && now >= item.updatedAt + 2500) this.engine.advance(`window-${item.id}`, item.id, 'appeal_window', now);
      if (item.verdict) this.effects.run(item.id);
    }
    this.publish();
  }
  async flush(): Promise<void> { await Promise.all([...this.analyses]); await this.effects.flush(); }
  dispose(): void { this.removeAllListeners(); }
}
