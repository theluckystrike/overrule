import { createServer } from 'node:http';
export async function fakeHelix() {
  const calls: Array<{ method: string; path: string; query: Record<string, string>; body: any }> = [];
  let status = 200; let dropped = false; let hang = false;
  let active: any;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    const call = { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null }; calls.push(call);
    if (req.headers.authorization !== 'Bearer fake-token' || req.headers['client-id'] !== 'fake-client') { res.writeHead(401); res.end(); return; }
    if (hang) return;
    if (status !== 200) { res.writeHead(status); res.end(JSON.stringify({ message: 'REMOTE SECRET MUST NEVER BE LOGGED' })); return; }
    res.setHeader('Content-Type', 'application/json');
    if (call.path === '/helix/moderation/bans' && req.method === 'POST') {
      const data = call.body?.data;
      if (!data?.duration || data.duration > 600 || call.query.broadcaster_id !== 'channel-test' || call.query.moderator_id !== 'mod') { res.writeHead(400); res.end('{}'); return; }
      active = { user_id: data.user_id, moderator_id: 'mod', created_at: '2026-10-26T00:00:00Z', expires_at: '2026-10-26T00:10:00Z', reason: data.reason };
      res.end(JSON.stringify({ data: [{ ...active, broadcaster_id: 'channel-test', end_time: active.expires_at }] }));
    } else if (call.path === '/helix/chat/messages' && req.method === 'POST') {
      if (call.body?.sender_id !== 'mod' || call.body?.broadcaster_id !== 'channel-test' || !call.body?.message) { res.writeHead(400); res.end('{}'); return; }
      res.end(JSON.stringify({ data: [{ message_id: 'chat-id', is_sent: !dropped }] }));
    } else if (call.path === '/helix/moderation/banned' && req.method === 'GET') res.end(JSON.stringify({ data: active ? [active] : [] }));
    else if (call.path === '/helix/moderation/bans' && req.method === 'DELETE') { active = undefined; res.writeHead(204); res.end(); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/helix/`,
    setStatus: (n: number) => { status = n; }, setDropped: () => { dropped = true; }, setHang: () => { hang = true; },
    replaceBan: () => { active = { ...active, expires_at: '', reason: 'Another moderator action' }; },
    close: () => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); } };
}
