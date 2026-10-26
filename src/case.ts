import { randomUUID } from 'node:crypto';
import type { Journal } from './precedent.ts';

export type State = 'open' | 'evidence' | 'voting' | 'awaiting_approval' | 'ruling' | 'appeal_window' | 'closed';
export type Verdict = 'guilty' | 'notguilty';
export type Role = 'viewer' | 'moderator' | 'broadcaster';
export interface Evidence { id: string; userId: string; login: string; text: string; at: number }
export interface CaseFile {
  id: string; streamId: string; state: State; message: Evidence; reason: string;
  rule: string; openedAt: number; updatedAt: number; deadline?: number; appealDeadline?: number;
  votes: Record<string, { name: string; choice: Verdict; weight: number; changed: boolean }>;
  arrivals: number[]; contested: boolean; jury: Verdict | null; verdict: Verdict | null;
  timeoutSeconds: number; appealed: boolean; overturned: boolean;
}
const edges: Partial<Record<State, State>> = {
  open: 'evidence', evidence: 'voting', voting: 'awaiting_approval',
  ruling: 'appeal_window', appeal_window: 'closed',
};
export class CaseEngine {
  private journal: Journal;
  private streamId: string;
  constructor(journal: Journal, streamId: string) {
    this.journal = journal; this.streamId = streamId;
  }
  list(): CaseFile[] { return this.journal.cases(); }
  operation(op: string): CaseFile | undefined { return this.duplicate(op); }
  get(id: string): CaseFile {
    const c = this.list().find(c => c.id === id);
    if (!c) throw new Error('Unknown case');
    return c;
  }
  private write(op: string, c: CaseFile, action: string, at: number): CaseFile {
    if (!op || !Number.isFinite(at) || at < c.updatedAt) throw new Error('Invalid operation or case clock');
    c.updatedAt = at;
    this.journal.append({ version: 1, op, action, at, case: c });
    return this.get(c.id);
  }
  private duplicate(op: string): CaseFile | undefined {
    const id = this.journal.operation(op); return id ? this.get(id) : undefined;
  }
  open(op: string, message: Evidence, reason: string, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    if (!message.id || !message.userId || !message.login || !message.text || !Number.isFinite(message.at)) throw new Error('Invalid evidence');
    if (at - message.at > 120000 || message.at > at + 5000) throw new Error('Message too old or in future');
    if (this.list().some(c => c.message.userId === message.userId && c.state !== 'closed')) throw new Error('User has an active case');
    if (!reason.trim() || reason.length > 500) throw new Error('Reason required with at most 500 characters');
    const c: CaseFile = {
      id: randomUUID(), streamId: this.streamId, state: 'open', message: structuredClone(message),
      reason, rule: /spam/i.test(reason) ? 'spam' : /harass|insult|kind/i.test(reason) ? 'harassment' : /link/i.test(reason) ? 'links' : 'channel-conduct', openedAt: at, updatedAt: at,
      votes: {}, arrivals: [], contested: false, jury: null, verdict: null,
      timeoutSeconds: 0, appealed: false, overturned: false,
    };
    return this.write(op, c, 'open', at);
  }
  advance(op: string, id: string, next: State, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    const c = this.get(id);
    if (edges[c.state] !== next) throw new Error('Invalid state transition');
    if (next === 'closed' && c.appealed) throw new Error('Appeal needs a streamer ruling');
    c.state = next;
    if (next === 'voting') c.deadline = at + 25000;
    if (next === 'awaiting_approval') {
      const votes = Object.values(c.votes);
      const guilty = votes.filter(v => v.choice === 'guilty').reduce((n, v) => n + v.weight, 0);
      const innocent = votes.filter(v => v.choice === 'notguilty').reduce((n, v) => n + v.weight, 0);
      c.jury = votes.length < 3 || guilty === innocent ? null : guilty > innocent ? 'guilty' : 'notguilty';
    }
    if (next === 'appeal_window') c.appealDeadline = at + 120000;
    if (next === 'closed') { c.message.text = ''; c.reason = ''; }
    return this.write(op, c, next, at);
  }
  vote(op: string, id: string, userId: string, name: string, role: Role, choice: Verdict, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    const c = this.get(id);
    if (c.state !== 'voting' || at >= c.deadline!) throw new Error('Vote deadline passed or voting not open');
    if (at < c.deadline! - 25000) throw new Error('Vote before voting opened');
    if (userId === c.message.userId) throw new Error('The accused cannot vote');
    if (choice !== 'guilty' && choice !== 'notguilty') throw new Error('Invalid vote');
    const existing = Object.hasOwn(c.votes, userId);
    if (!existing) c.arrivals.push(at);
    c.arrivals = c.arrivals.filter(t => t >= at - 10000);
    c.contested ||= c.arrivals.length > 40;
    Object.defineProperty(c.votes, userId, { value: { name, choice, weight: role === 'viewer' ? 1 : 3, changed: existing }, enumerable: true, writable: true, configurable: true });
    return this.write(op, c, existing ? 'vote_changed' : 'vote', at);
  }
  decide(op: string, id: string, verdict: Verdict, streamerApproved: boolean, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    const c = this.get(id);
    if (!streamerApproved) throw new Error('Explicit streamer decision required');
    if (c.state !== 'awaiting_approval') throw new Error('Invalid state transition');
    if (verdict !== 'guilty' && verdict !== 'notguilty') throw new Error('Invalid verdict');
    if (verdict === 'guilty' && at - c.message.at > 120000) throw new Error('Message too old for action');
    c.verdict = verdict; c.timeoutSeconds = verdict === 'guilty' ? 600 : 0; c.state = 'ruling';
    return this.write(op, c, 'streamer_decision', at);
  }
  appeal(op: string, id: string, userId: string, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    const c = this.get(id);
    if (c.state !== 'appeal_window' || at >= c.appealDeadline! || userId !== c.message.userId) throw new Error('Appeal not available');
    if (this.list().some(other => other.streamId === c.streamId && other.message.userId === userId && other.appealed)) throw new Error('Only one appeal per stream');
    c.appealed = true;
    return this.write(op, c, 'appeal_requested', at);
  }
  resolveAppeal(op: string, id: string, overturn: boolean, streamerApproved: boolean, at: number): CaseFile {
    const prior = this.duplicate(op); if (prior) return prior;
    const c = this.get(id);
    if (!streamerApproved || c.state !== 'appeal_window' || !c.appealed) throw new Error('Appeal needs a streamer ruling');
    c.overturned = overturn;
    if (overturn) { c.verdict = 'notguilty'; c.timeoutSeconds = 0; }
    c.state = 'closed'; c.message.text = ''; c.reason = '';
    return this.write(op, c, 'appeal_resolved', at);
  }
  tick(at: number): void {
    for (const c of this.list()) {
      if (c.state === 'voting' && at >= c.deadline!) this.advance(`timer-vote-${c.id}`, c.id, 'awaiting_approval', at);
      if (c.state === 'appeal_window' && !c.appealed && at >= c.appealDeadline!) this.advance(`timer-close-${c.id}`, c.id, 'closed', at);
    }
  }
}
