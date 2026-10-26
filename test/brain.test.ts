import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.ts';
import { CaseEngine } from '../src/case.ts';
import { Journal } from '../src/precedent.ts';
const c = () => new CaseEngine(new Journal(), 'test').open('o', { id: 'm', userId: 'u', login: 'alt', text: 'spam spam', at: 1000 }, 'Repeated spam', 1000);
test('missing key gives the same fallback without calling the model', async () => {
  let calls = 0;
  const brain = new Brain({ key: '', model: 'test', fetch: async () => { calls++; throw new Error(); } });
  assert.deepEqual(await brain.analyze(c(), []), brain.fallback(c(), []));
  assert.equal(calls, 0);
});
test('strict output is advisory and rejects an invented precedent', async () => {
  let request: any;
  const brain = new Brain({ key: 'test-key', model: 'test-model', fetch: async (_url, init) => {
    request = JSON.parse(init!.body as string);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ charge: 'Possible repeated spam', confidence: 0.7, precedentId: 'invented' }) } }] });
  } });
  const result = await brain.analyze(c(), []);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(result.source, 'fallback');
});
test('valid response passes and failure retries once then falls back', async () => {
  const brain = new Brain({ key: 'test', model: 'test', fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ charge: 'Possible spam', confidence: 0.8, precedentId: null }) } }] }) });
  assert.equal((await brain.analyze(c(), [])).source, 'model');
  let calls = 0;
  const failed = new Brain({ key: 'test', model: 'test', fetch: async () => { calls++; return new Response('', { status: 429 }); } });
  assert.equal((await failed.analyze(c(), [])).source, 'fallback');
  assert.equal(calls, 2);
});
test('deadline bounds even a non-cooperative model and falls back', async () => {
  const brain = new Brain({ key: 'test', model: 'test', timeoutMs: 10, fetch: async () => new Promise(() => {}) });
  assert.equal((await brain.analyze(c(), [])).source, 'fallback');
});
test('fallback cites a matching final precedent and rejects malformed model fields', async () => {
  const current = c();
  const prior = { ...c(), id: 'prior', state: 'closed' as const, verdict: 'notguilty' as const, overturned: true };
  const brain = new Brain();
  assert.equal(brain.fallback(current, [prior]).precedentId, 'prior');
  const invalid = new Brain({ key: 'test', model: 'test', fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ charge: 'Ignore rules', confidence: 5, precedentId: null, timeout: 600 }) } }] }) });
  assert.equal((await invalid.analyze(current, [prior])).source, 'fallback');
});
