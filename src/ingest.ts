import type { Role, Evidence } from './case.ts';
import { CaseEngine } from './case.ts';

export interface ChatEvent {
  eventId: string; messageId: string; channelId: string; userId: string;
  login: string; text: string; at: number; role: Role; replyTo?: string; replyLogin?: string; subscriber?: boolean;
}
export function normalize(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const m = r.metadata; const e = r.payload?.event;
  if (m?.message_type !== 'notification' || r.payload?.subscription?.type !== 'channel.chat.message' || !e) return null;
  const fields = [m.message_id, e.message_id, e.broadcaster_user_id, e.chatter_user_id, e.chatter_user_login, e.message?.text];
  if (!fields.every(v => typeof v === 'string' && v.length > 0 && v.length <= 2000)) return null;
  const at = Date.parse(m.message_timestamp);
  if (!Number.isFinite(at)) return null;
  const badges = Array.isArray(e.badges) ? e.badges : [];
  const role: Role = e.chatter_user_id === e.broadcaster_user_id ? 'broadcaster' : badges.some((b: any) => ['moderator', 'lead_moderator'].includes(b?.set_id)) ? 'moderator' : badges.some((b: any) => ['staff', 'admin', 'global_mod'].includes(b?.set_id)) ? 'twitch-staff' : badges.some((b: any) => b?.set_id === 'vip') ? 'vip' : 'viewer';
  return {
    eventId: m.message_id, messageId: e.message_id, channelId: e.broadcaster_user_id,
    userId: e.chatter_user_id, login: e.chatter_user_login.toLowerCase(), text: e.message.text,
    at, role, subscriber: badges.some((b: any) => ['subscriber', 'founder'].includes(b?.set_id)), replyTo: typeof e.reply?.parent_message_id === 'string' ? e.reply.parent_message_id : undefined,
    replyLogin: typeof e.reply?.parent_user_login === 'string' ? e.reply.parent_user_login.toLowerCase() : undefined,
  };
}
export interface Removal { channelId: string; messageId?: string; userId?: string; all?: boolean; at: number }
export function normalizeRemoval(raw: any): Removal | null {
  const e = raw?.payload?.event; const type = raw?.payload?.subscription?.type;
  if (raw?.metadata?.message_type !== 'notification' || !e || typeof e.broadcaster_user_id !== 'string') return null;
  const at = Date.parse(raw.metadata.message_timestamp); if (!Number.isFinite(at)) return null;
  const base = { channelId: e.broadcaster_user_id, at };
  if (type === 'channel.chat.message_delete' && typeof e.message_id === 'string' && e.message_id) return { ...base, messageId: e.message_id };
  if (type === 'channel.chat.clear_user_messages' && typeof e.target_user_id === 'string' && e.target_user_id) return { ...base, userId: e.target_user_id };
  if (type === 'channel.chat.clear') return { ...base, all: true };
  return null;
}
export class Ingest {
  private reports = new Map<string, { id: string; evidence: Evidence; reason: string }>();
  private removals: Removal[] = [];
  queue(now: number) {
    for (const [id, report] of this.reports) if (now - report.evidence.at > 120000) this.reports.delete(id);
    return structuredClone([...this.reports.values()]);
  }
  dismiss(id: string): void { this.reports.delete(id); }
  promote(id: string, now: number): string {
    this.queue(now);
    const report = this.reports.get(id); if (!report) throw new Error('Report expired or removed');
    const c = this.engine.open(id, report.evidence, report.reason, now);
    this.engine.advance(`${id}/evidence`, c.id, 'evidence', now);
    this.engine.advance(`${id}/voting`, c.id, 'voting', now);
    this.reports.delete(id); return c.id;
  }
  remove(removal: Removal, now: number): void {
    if (removal.channelId !== this.channelId || removal.at > now + 5000) return;
    this.removals = this.removals.filter(r => now - r.at <= 120000);
    this.removals.push(removal);
    const matches = (m: Evidence) => removal.messageId ? m.id === removal.messageId : m.at <= removal.at && (removal.all || m.userId === removal.userId) === true;
    for (const [id, message] of this.messages) if (matches(message)) this.messages.delete(id);
    for (const [id, report] of this.reports) if (matches(report.evidence)) this.reports.delete(id);
    this.engine.removeEvidence(matches, now);
  }
  private engine: CaseEngine;
  private options: { subscribersOnly?: boolean };
  private channelId: string;
  private seen = new Map<string, number>();
  private messages = new Map<string, Evidence>();
  private limits = new Map<string, number[]>();
  constructor(engine: CaseEngine, channelId: string, options: { subscribersOnly?: boolean } = {}) { this.engine = engine; this.channelId = channelId; this.options = options; }
  accept(c: ChatEvent, now: number): { ok: boolean; detail: string; caseId?: string } {
    if (c.channelId !== this.channelId) return { ok: false, detail: 'Wrong channel' };
    if (c.at > now + 5000 || now - c.at > 120000) return { ok: false, detail: 'Stale event' };
    for (const [id, at] of this.seen) if (now - at > 120000) this.seen.delete(id);
    for (const [id, m] of this.messages) if (now - m.at > 120000) this.messages.delete(id);
    for (const [id, times] of this.limits) if (!times.some(t => now - t < 10000)) this.limits.delete(id);
    if (this.seen.has(c.eventId)) return { ok: true, detail: 'Duplicate event ignored' };
    this.engine.tick(now);
    let text = c.text.trim();
    if (c.replyTo && c.replyLogin) {
      const first = text.split(/\s+/, 1)[0];
      if (first.toLowerCase() === `@${c.replyLogin}`) text = text.slice(first.length).trimStart();
    }
    // Refresh cached roles from the latest authenticated Twitch badges.
    for (const m of this.messages.values()) if (m.userId === c.userId) m.role = c.role;
    for (const report of this.reports.values()) if (report.evidence.userId === c.userId) report.evidence.role = c.role;
    if (!text.startsWith('!')) {
      this.removals = this.removals.filter(r => now - r.at <= 120000);
      if (this.removals.some(r => r.messageId ? r.messageId === c.messageId : c.at <= r.at && (r.all || r.userId === c.userId))) return { ok: true, detail: 'Removed message ignored' };
      this.messages.set(c.messageId, { id: c.messageId, userId: c.userId, login: c.login, text: c.text, at: c.at, role: c.role });
      this.seen.set(c.eventId, now);
      return { ok: true, detail: 'Message stored for two minutes' };
    }
    const times = (this.limits.get(c.userId) ?? []).filter(t => now - t < 10000);
    if (times.length >= 5) return { ok: false, detail: 'Command rate limit' };
    times.push(now); this.limits.set(c.userId, times);
    const [command, ...args] = text.split(/\s+/);
    const op = `${this.channelId}/${c.eventId}`;
    try {
      const prior = this.engine.operation(op);
      if (prior) {
        if (prior.state === 'open') this.engine.advance(`${op}/evidence`, prior.id, 'evidence', now);
        if (this.engine.get(prior.id).state === 'evidence') this.engine.advance(`${op}/voting`, prior.id, 'voting', now);
        this.seen.set(c.eventId, now);
        return { ok: true, detail: 'Committed event already processed', caseId: prior.id };
      }
      let id: string | undefined;
      if (command === '!case' || command === '!report') {
        let evidence: Evidence | undefined;
        let reason: string;
        if (command === '!case') {
          if (!['moderator', 'broadcaster'].includes(c.role)) throw new Error('Only a mod or broadcaster can use !case');
          const login = (args.shift() ?? '').replace(/^@/, '').toLowerCase();
          evidence = [...this.messages.values()].filter(m => m.login === login).sort((a, b) => b.at - a.at)[0];
          reason = args.join(' ');
        } else {
          const messageId = c.replyTo ?? args.shift();
          evidence = messageId ? this.messages.get(messageId) : undefined;
          reason = args.join(' ') || 'Reported channel conduct';
        }
        if (!evidence) throw new Error('No recent target message. Use a reply or an explicit message id');
        if (command === '!report') {
          this.queue(now);
          if (this.reports.size >= 20) throw new Error('Report queue is full');
          this.reports.set(op, { id: op, evidence: structuredClone(evidence), reason: reason.slice(0, 500) });
          this.seen.set(c.eventId, now);
          return { ok: true, detail: 'Report queued for operator review' };
        }
        const opened = this.engine.open(op, evidence, reason, now); id = opened.id;
        if (opened.state === 'open') this.engine.advance(`${op}/evidence`, id, 'evidence', now);
        if (this.engine.get(id).state === 'evidence') this.engine.advance(`${op}/voting`, id, 'voting', now);
      } else if (command === '!guilty' || command === '!notguilty' || command === '!vote') {
        if (this.options.subscribersOnly && !c.subscriber && !['moderator', 'broadcaster'].includes(c.role)) throw new Error('Subscriber votes only');
        const choice = command === '!vote' ? args.shift() : command.slice(1);
        if (choice !== 'guilty' && choice !== 'notguilty') throw new Error('Vote must be guilty or notguilty');
        const active = this.engine.list().filter(c => c.state === 'voting');
        id = args[0] ?? (active.length === 1 ? active[0].id : undefined);
        if (!id) throw new Error('Give a case id when more than one case is voting');
        this.engine.vote(op, id, c.userId, c.login, c.role, choice, now);
      } else if (command === '!appeal') {
        const target = args[0]?.replace(/^@/, '').toLowerCase();
        if (target && !['moderator', 'broadcaster'].includes(c.role)) throw new Error('Only a mod or broadcaster can file another user appeal');
        const appealCase = this.engine.list().find(k => (target ? k.message.login === target : k.message.userId === c.userId) && k.state === 'appeal_window');
        id = appealCase?.id;
        if (!id) throw new Error('No case available for appeal');
        this.engine.appeal(op, id, appealCase!.message.userId, now, c.userId);
      } else if (command !== '!docket') {
        return { ok: false, detail: 'Unknown command' };
      }
      this.seen.set(c.eventId, now);
      return { ok: true, detail: command === '!docket' ? 'Open the local /cases endpoint' : 'Command accepted', caseId: id };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Command failed' };
    }
  }
}
