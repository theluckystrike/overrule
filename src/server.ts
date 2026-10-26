import { createServer } from 'node:http';
import { CaseEngine } from './case.ts';
import { Journal, consistency } from './precedent.ts';

const engine = new CaseEngine(new Journal('data/sim-audit.jsonl'), 'local');
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (req.url === '/cases') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ cases: engine.list(), consistency: consistency(engine.list()) })); return;
  }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Overrule</title><h1>Overrule</h1><p>Offline foundation. Live Twitch access is disabled.</p><p><a href="/cases">Read the local case snapshot</a></p><p>Run the simulator before starting this server. Overlay and operator controls are due on day 3.</p>'); return;
  }
  res.writeHead(404); res.end('Not available in the day 2 build');
});
server.listen(3000, '127.0.0.1', () => console.log('Overrule local snapshot server on port 3000. Twitch is not connected.'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
