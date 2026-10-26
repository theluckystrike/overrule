import { existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CaseFile } from './case.ts';

export interface RecordEntry { version: 1; op: string; action: string; at: number; case: CaseFile }
function validRecord(r: RecordEntry): boolean {
  const c = r.case;
  const states = ['open', 'evidence', 'voting', 'awaiting_approval', 'ruling', 'appeal_window', 'closed'];
  return r.version === 1 && typeof r.op === 'string' && r.op.length > 0 && typeof r.action === 'string'
    && Number.isFinite(r.at) && !!c && typeof c.id === 'string' && typeof c.streamId === 'string'
    && states.includes(c.state) && Number.isFinite(c.openedAt) && Number.isFinite(c.updatedAt)
    && !!c.message && ['id', 'userId', 'login', 'text'].every(k => typeof (c.message as unknown as Record<string, unknown>)[k] === 'string')
    && Number.isFinite(c.message.at) && typeof c.reason === 'string' && typeof c.rule === 'string'
    && Array.isArray(c.arrivals) && c.arrivals.every(Number.isFinite)
    && !!c.votes && typeof c.votes === 'object' && !Array.isArray(c.votes)
    && Object.values(c.votes).every(v => !!v && typeof v.name === 'string' && ['guilty', 'notguilty'].includes(v.choice) && [1, 3].includes(v.weight) && typeof v.changed === 'boolean')
    && [c.contested, c.appealed, c.overturned].every(v => typeof v === 'boolean')
    && [c.jury, c.verdict].every(v => v === null || v === 'guilty' || v === 'notguilty')
    && [0, 600].includes(c.timeoutSeconds)
    && (c.state !== 'voting' || Number.isFinite(c.deadline))
    && (c.state !== 'appeal_window' || Number.isFinite(c.appealDeadline));
}
/** One writer per journal. Each committed mutation is also its audit entry. */
export class Journal {
  private path?: string;
  private index = new Map<string, CaseFile>();
  private operations = new Map<string, string>();
  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('Incomplete journal record. Restore the journal before use');
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line) as RecordEntry;
          if (!validRecord(r)) throw new Error();
          this.apply(r);
        } catch { throw new Error('Invalid journal record. Restore the journal before use'); }
      }
    }
  }
  cases(): CaseFile[] { return structuredClone([...this.index.values()]); }
  operation(op: string): string | undefined { return this.operations.get(op); }
  private apply(r: RecordEntry): void {
    this.index.set(r.case.id, structuredClone(r.case)); this.operations.set(r.op, r.case.id);
  }
  append(r: RecordEntry): void {
    if (this.operations.has(r.op)) return;
    if (!validRecord(r)) throw new Error('Invalid journal record');
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, 'a', 0o600);
      try {
        const data = Buffer.from(JSON.stringify(r) + '\n');
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    this.apply(r);
  }
}
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
export function nearest(cases: CaseFile[], rule: string): CaseFile | null {
  const query = words(rule);
  let best: CaseFile | null = null; let score = 0;
  for (const c of cases.filter(c => c.state === 'closed' && c.verdict)) {
    const candidate = words(c.rule);
    const union = new Set([...query, ...candidate]);
    const similarity = [...query].filter(w => candidate.has(w)).length / (union.size || 1);
    if (similarity > score) { best = c; score = similarity; }
  }
  return best ? structuredClone(best) : null;
}
/** Fraction of same-rule pairs with the same final verdict. Null means no pairs. */
export function consistency(cases: CaseFile[]): number | null {
  const closed = cases.filter(c => c.state === 'closed' && c.verdict);
  let pairs = 0; let agrees = 0;
  for (let i = 0; i < closed.length; i++) for (let j = i + 1; j < closed.length; j++) {
    if (closed[i].rule === closed[j].rule) { pairs++; if (closed[i].verdict === closed[j].verdict) agrees++; }
  }
  return pairs ? agrees / pairs : null;
}
