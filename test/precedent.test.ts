import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Journal, nearest, consistency } from '../src/precedent.ts';
import { CaseEngine } from '../src/case.ts';

test('journal restores state and operation ids and refuses damaged records', () => {
  const path = join(process.cwd(), `data-test-${randomUUID()}.jsonl`);
  try {
    const e = new CaseEngine(new Journal(path), 'test');
    e.open('event1', { id: 'm', userId: 'u', login: 'alt', text: 'test', at: 1000 }, 'Be kind', 1000);
    const restored = new CaseEngine(new Journal(path), 'test');
    assert.equal(restored.list().length, 1);
    restored.open('event1', { id: 'm', userId: 'u', login: 'alt', text: 'test', at: 1000 }, 'Be kind', 1000);
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
    assert.equal(nearest(restored.list(), 'Be kind'), null);
    assert.equal(consistency([]), null);
    appendFileSync(path, '{broken');
    assert.throws(() => new Journal(path), /journal/);
  } finally {
    // Journal closes every descriptor. Delete only this test's own small file.
    if (existsSync(path)) {
      const entry = `${readFileSync(path).length} bytes ${path}\n`;
      appendFileSync('DELETIONS-MANIFEST.txt', entry);
      const sprintManifest = join(homedir(), 'sprint-1026-work/DELETIONS-MANIFEST.txt');
      if (existsSync(sprintManifest)) appendFileSync(sprintManifest, entry);
      unlinkSync(path);
    }
  }
});
test('precedent uses final verdicts and consistency compares the same rule', () => {
  const e = new CaseEngine(new Journal(), 'test');
  const close = (i: number, guilty: boolean) => {
    const c = e.open(`o${i}`, { id: `m${i}`, userId: `u${i}`, login: `alt${i}`, text: 'test', at: 1000 }, 'Spam', 1000);
    e.advance(`e${i}`, c.id, 'evidence', 1000);
    e.advance(`v${i}`, c.id, 'voting', 1000);
    e.advance(`s${i}`, c.id, 'awaiting_approval', 2000);
    e.decide(`d${i}`, c.id, guilty ? 'guilty' : 'notguilty', true, 2001);
    e.advance(`w${i}`, c.id, 'appeal_window', 2002);
    e.advance(`c${i}`, c.id, 'closed', 122002);
    return c.id;
  };
  const id = close(1, true); close(2, true); close(3, false);
  assert.equal(nearest(e.list(), 'spam')?.id, id);
  assert.equal(nearest(e.list(), 'links'), null);
  assert.equal(consistency(e.list()), 1 / 3);
});
