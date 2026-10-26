const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="operator-token"]').content;
let snapshot;
let connected = false;
function render() {
  const s = snapshot; const c = s?.current;
  $('evidence').textContent = c?.message.deleted ? 'Evidence removed by Twitch moderation' : c?.message.text || 'No evidence';
  $('reveal').disabled = !connected || !c?.message.text || c?.revealed;
  $('force-guilty').disabled = !connected || c?.state !== 'awaiting_approval';
  $('reports').replaceChildren(...(s?.reports ?? []).map(r => {
    const li = document.createElement('li'); const text = document.createElement('span');
    text.textContent = `@${r.evidence.login} · ${r.reason} · ${r.evidence.text} `; li.append(text);
    for (const action of ['promote', 'dismiss']) { const button = document.createElement('button'); button.textContent = action; button.onclick = () => post('/api/control', { action, caseId: r.id }); li.append(button); }
    return li;
  }));
  $('phase').textContent = c ? c.state.replaceAll('_', ' ').toUpperCase() : 'NO ACTIVE CASE';
  $('case-title').textContent = c ? `@${c.message.login} · ${c.reason || 'Case closed'}` : 'Waiting for a report';
  $('summary').textContent = c ? `${Object.keys(c.votes).length} jurors · Jury result ${c.jury ?? 'pending'} · ${c.verdict ? `Final result ${c.verdict}` : 'No ruling yet'}` : 'The fixture uses three synthetic jurors.';
  $('action-deadline').textContent = c && ['voting', 'awaiting_approval'].includes(c.state) ? `Action expires in ${Math.max(0, Math.ceil(((c.actionDeadline ?? c.openedAt + 300000) - s.now) / 1000))} seconds` : c?.state === 'expired' ? 'Ruling expired. No action.' : '';
  $('mode').textContent = s?.autoApprove ? 'Demo mode · A synthetic approval follows the vote deadline.' : `Manual mode · ${s?.liveSource ? 'Twitch chat' : 'Fixtures'} · Actions ${s?.actionMode ?? 'unknown'}. A streamer key press is required.`;
  $('pending').textContent = s?.pending ? s.pending.veto ? 'Veto queued · No action' : 'Approval queued · V can still veto' : '';
  $('close').disabled = !connected || c?.state !== 'voting';
  $('approve').disabled = $('veto').disabled = !connected || c?.state !== 'awaiting_approval';
  $('replay').disabled = !connected || s?.liveSource || s?.replaying || !!s?.cases.some(c => !['closed', 'expired'].includes(c.state));
  $('appeal-controls').hidden = c?.state !== 'appeal_window';
  $('appeal-status').textContent = c?.appealed ? 'The accused requested an appeal. Review the ruling.' : 'A mod can file !appeal @login within two minutes. This button simulates a request.';
  $('demo-appeal').disabled = !connected || c?.state !== 'appeal_window' || c?.appealed || s?.actionMode === 'live';
  $('uphold').disabled = $('overturn').disabled = !connected || c?.state !== 'appeal_window' || !c?.appealed;
  $('voters').replaceChildren(...Object.values(c?.votes ?? {}).map(v => {
    const li = document.createElement('li'); li.textContent = `${v.name} · ${v.choice === 'guilty' ? 'Guilty' : 'Not guilty'} ×${v.weight}${v.changed ? ' · Changed' : ''}`; return li;
  }));
}
async function post(path, body) {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Overrule-Token': token }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $('feedback').textContent = '';
  } catch (e) { $('feedback').textContent = e.message; }
}
for (const action of ['reveal', 'force-guilty', 'close', 'approve', 'veto', 'demo-appeal', 'uphold', 'overturn']) $(action).onclick = () => {
  if (!$(action).disabled && snapshot?.current) void post('/api/control', { action, caseId: snapshot.current.id });
};
$('replay').onclick = () => { if (!$('replay').disabled) void post('/api/replay', {}); };
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const action = e.code === 'Space' ? 'close' : e.key.toLowerCase() === 'a' ? 'approve' : e.key.toLowerCase() === 'v' ? 'veto' : e.key.toLowerCase() === 'g' ? 'force-guilty' : null;
  if (action) { e.preventDefault(); $(action).click(); }
});
const events = new EventSource('/events?operator=1');
events.addEventListener('snapshot', e => {
  connected = true; snapshot = JSON.parse(e.data); $('connection').textContent = '● Connected'; $('connection').classList.add('online'); render();
});
events.onerror = () => { connected = false; $('connection').textContent = 'Reconnecting…'; $('connection').classList.remove('online'); render(); };
window.addEventListener('pagehide', () => events.close());
render();
