import { terminal } from './case.ts';
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { VoteLoop, type Control } from './loop.ts';
import { Journal } from './precedent.ts';
import { replay } from './replay.ts';
import { configuredBrain } from './brain.ts';

export function createApp(loop: VoteLoop, options: { autoStart?: boolean; tick?: boolean; live?: boolean } = {}) {
  const token = randomBytes(32).toString('hex');
  const clients = new Map<ServerResponse, boolean>();
  const abort = new AbortController();
  let started = false;
  const broadcast = (snapshot: ReturnType<VoteLoop['snapshot']>) => {
    for (const [res, operator] of clients) {
      const s = operator ? loop.snapshot(true) : snapshot;
      const frame = `id: ${s.revision}\nevent: snapshot\ndata: ${JSON.stringify(s)}\n\n`;
      if (!res.write(frame)) { clients.delete(res); res.destroy(); }
    }
  };
  loop.on('snapshot', broadcast);
  const run = () => replay(loop, { signal: abort.signal }).catch(() => {
    if (!abort.signal.aborted) console.error('Fixture replay stopped. Check the current case before retrying');
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 3000;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host ?? '')) { res.writeHead(403); res.end('Local access only'); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['x-overrule-token'] !== token) { json(403, { error: 'Use the local operator page' }); return; }
        if (url.pathname === '/api/replay') {
          if (options.live) { json(403, { error: 'Fixtures are disabled on the live channel' }); return; }
          if (loop.replaying || loop.engine.list().some(c => !terminal(c.state))) { json(409, { error: 'Wait for the current case to close' }); return; }
          void run(); json(202, { ok: true }); return;
        }
        if (url.pathname !== '/api/control') { json(404, { error: 'Unknown route' }); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) { json(413, { error: 'Request too large' }); return; } }
        let input;
        try { input = JSON.parse(body); } catch { json(400, { error: 'Invalid request' }); return; }
        if (!input || !['promote', 'dismiss', 'reveal', 'force-guilty', 'close', 'approve', 'veto', 'demo-appeal', 'uphold', 'overturn'].includes(input.action) || typeof input.caseId !== 'string') { json(400, { error: 'Invalid control' }); return; }
        try { loop.control(input.action as Control, input.caseId); json(200, { ok: true }); }
        catch (e) { json(409, { error: e instanceof Error ? e.message : 'Control rejected' }); }
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (url.pathname === '/cases') { json(200, loop.snapshot()); return; }
      if (url.pathname === '/events') {
        const operator = url.searchParams.get('operator') === '1';
        if (operator && !req.headers.cookie?.split('; ').includes(`overrule_operator=${token}`)) { json(403, { error: 'Use the local operator page' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 1000\n\n'); clients.set(res, operator);
        // Always send a complete snapshot, including after Last-Event-ID reconnects.
        const s = loop.snapshot(operator);
        res.write(`id: ${s.revision}\nevent: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
        req.on('close', () => clients.delete(res));
        if (options.autoStart && !started) { started = true; void run(); }
        return;
      }
      const files: Record<string, [string, string]> = {
        '/': ['operator.html', 'text/html'], '/operator': ['operator.html', 'text/html'],
        '/overlay': ['overlay.html', 'text/html'], '/overlay.js': ['overlay.js', 'text/javascript'],
        '/operator.js': ['operator.js', 'text/javascript'], '/overlay.css': ['overlay.css', 'text/css'],
        '/docket': ['docket.html', 'text/html'], '/docket.js': ['docket.js', 'text/javascript'],
      };
      const file = files[url.pathname];
      if (!file) { res.writeHead(404); res.end('Not found'); return; }
      let content = await readFile(new URL(`../public/${file[0]}`, import.meta.url), 'utf8');
      if (file[0] === 'operator.html') { content = content.replace('__OPERATOR_TOKEN__', token); res.setHeader('Set-Cookie', `overrule_operator=${token}; HttpOnly; SameSite=Strict; Path=/`); }
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(content);
    } catch { if (!res.headersSent) json(500, { error: 'Local server error' }); else res.end(); }
  });
  const timer = options.tick === false ? undefined : setInterval(() => loop.tick(), 250);
  server.on('close', () => { if (timer) clearInterval(timer); loop.off('snapshot', broadcast); });
  function stop() {
    abort.abort();
    if (timer) clearInterval(timer);
    for (const res of clients.keys()) res.end();
    clients.clear();
    return new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
  return { server, stop };
}

export function startServer(autoDemo = false) {
  if (process.env.DRY_RUN === '0') throw new Error('OWNER-NEEDED. Live OAuth and channel gates are not complete. DRY_RUN must remain on');
  // A new demo process gets a new journal. Restart never inherits a half-finished show.
  const path = autoDemo ? `data/demo-${Date.now()}-${randomBytes(4).toString('hex')}.jsonl` : 'data/operator-audit.jsonl';
  const loop = new VoteLoop({ journal: new Journal(path), autoApprove: autoDemo, brain: configuredBrain() });
  const app = createApp(loop, { autoStart: autoDemo });
  app.server.listen(3000, '127.0.0.1', () => {
    console.log('Overrule ready on port 3000. Open /overlay or /operator.');
    console.log(autoDemo ? 'Synthetic demo starts when a page connects. No Twitch actions are sent.' : 'Manual mode. Start the fixture from the operator page. Live Twitch is disabled.');
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.stop().then(() => loop.dispose()); });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
