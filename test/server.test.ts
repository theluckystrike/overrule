import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.ts';
import { VoteLoop } from '../src/loop.ts';
import { replay } from '../src/replay.ts';

test('HTTP serves overlay and SSE snapshots, protects controls and reconnects', async () => {
  let now = 1000000;
  const loop = new VoteLoop({ now: () => now });
  const app = createApp(loop, { tick: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const abort = new AbortController();
  try {
    const overlay = await (await fetch(`${base}/overlay`)).text();
    assert.match(overlay, /case-card/); assert.match(overlay, /gavel/);
    assert.doesNotMatch(overlay, /operator-token/);
    const docket = await (await fetch(`${base}/docket`)).text();
    assert.match(docket, /CONSISTENCY/);
    assert.match(docket, /docket.js/);
    assert.doesNotMatch(docket, /operator-token/);
    const page = await (await fetch(`${base}/operator`)).text();
    const token = /name="operator-token" content="([a-f0-9]+)"/.exec(page)![1];
    const stream = await fetch(`${base}/events`, { signal: abort.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: snapshot/); assert.match(initial, /"current":null/);
    await replay(loop, { now: () => now, sleep: async ms => { now += ms; }, runId: 'http' });
    const card = loop.snapshot().current!;
    const payload = JSON.stringify({ action: 'close', caseId: card.id });
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', body: payload })).status, 403);
    const headers = { Origin: base, 'X-Overrule-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: payload })).status, 403);
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', headers, body: 'null' })).status, 400);
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', headers, body: payload })).status, 200);
    assert.equal(loop.snapshot().current!.state, 'awaiting_approval');
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'veto', caseId: card.id }) })).status, 200);
    now += 300; loop.tick();
    assert.equal(loop.snapshot().current!.verdict, 'notguilty');
    const reconnect = await fetch(`${base}/events`, { signal: abort.signal, headers: { 'Last-Event-ID': '0' } });
    const frame = new TextDecoder().decode((await reconnect.body!.getReader().read()).value);
    assert.match(frame, /"verdict":"notguilty"/);
    assert.match(frame, /"gavel":true/);
    assert.equal((await fetch(`${base}/api/replay`, { method: 'POST', headers })).status, 409);
  } finally { abort.abort(); await app.stop(); loop.dispose(); }
});

test('operator replay endpoint starts one fixture and rejects a concurrent start', async () => {
  const loop = new VoteLoop(); const app = createApp(loop, { tick: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const page = await (await fetch(`${base}/operator`)).text();
    const token = /name="operator-token" content="([a-f0-9]+)"/.exec(page)![1];
    const headers = { Origin: base, 'X-Overrule-Token': token };
    assert.equal((await fetch(`${base}/api/replay`, { method: 'POST', headers })).status, 202);
    assert.equal(loop.replaying, true);
    assert.equal((await fetch(`${base}/api/replay`, { method: 'POST', headers })).status, 409);
  } finally { await app.stop(); loop.dispose(); }
});

test('public HTTP and SSE redact evidence while authenticated operator SSE can review it', async () => {
  const loop = new VoteLoop({ now: () => 1000 }); const app = createApp(loop, { tick: false });
  const c = loop.engine.open('private', { id: 'm', userId: 'u', login: 'u', text: 'PRIVATE-EVIDENCE', at: 1000 }, 'PRIVATE-REASON', 1000);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; const abort = new AbortController();
  try {
    assert.doesNotMatch(await (await fetch(base + '/cases')).text(), /PRIVATE/);
    const publicStream = await fetch(base + '/events', { signal: abort.signal });
    assert.doesNotMatch(new TextDecoder().decode((await publicStream.body!.getReader().read()).value), /PRIVATE/);
    assert.equal((await fetch(base + '/events?operator=1')).status, 403);
    const page = await fetch(base + '/operator'); const cookie = page.headers.get('set-cookie')!.split(';')[0];
    const html = await page.text(); const token = /name="operator-token" content="([a-f0-9]+)"/.exec(html)![1];
    const privateStream = await fetch(base + '/events?operator=1', { signal: abort.signal, headers: { Cookie: cookie } });
    assert.match(new TextDecoder().decode((await privateStream.body!.getReader().read()).value), /PRIVATE-EVIDENCE/);
    const headers = { Origin: base, 'X-Overrule-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/control', { method: 'POST', headers, body: JSON.stringify({ action: 'reveal', caseId: c.id }) })).status, 200);
    assert.match(await (await fetch(base + '/cases')).text(), /PRIVATE-EVIDENCE/);
  } finally { abort.abort(); await app.stop(); loop.dispose(); }
});
