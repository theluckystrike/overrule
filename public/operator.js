const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="operator-token"]').content;
let snapshot;
let connected = false;
function render() {
  const s = snapshot; const c = s?.current;
  $('phase').textContent = c ? c.state.replaceAll('_', ' ').toUpperCase() : 'NO ACTIVE CASE';
  $('case-title').textContent = c ? `@${c.message.login} · ${c.reason || 'Case closed'}` : 'Waiting for a report';
  $('summary').textContent = c ? `${Object.keys(c.votes).length} jurors · Jury result ${c.jury ?? 'pending'} · ${c.verdict ? `Final result ${c.verdict}` : 'No ruling yet'}` : 'The fixture uses three synthetic jurors.';
  $('mode').textContent = s?.autoApprove ? 'Demo mode · A synthetic approval follows the vote deadline.' : 'Manual mode · A streamer key press is required.';
  $('pending').textContent = s?.pending ? s.pending.veto ? 'Veto queued · No action' : 'Approval queued · V can still veto' : '';
  $('close').disabled = !connected || c?.state !== 'voting';
  $('approve').disabled = $('veto').disabled = !connected || c?.state !== 'awaiting_approval';
  $('replay').disabled = !connected || s?.replaying || !!s?.cases.some(c => c.state !== 'closed');
  $('appeal-controls').hidden = c?.state !== 'appeal_window';
  $('appeal-status').textContent = c?.appealed ? 'The accused requested an appeal. Review the ruling.' : 'The accused has two minutes to appeal. This button simulates their chat command.';
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
for (const action of ['close', 'approve', 'veto', 'demo-appeal', 'uphold', 'overturn']) $(action).onclick = () => {
  if (!$(action).disabled && snapshot?.current) void post('/api/control', { action, caseId: snapshot.current.id });
};
$('replay').onclick = () => { if (!$('replay').disabled) void post('/api/replay', {}); };
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const action = e.code === 'Space' ? 'close' : e.key.toLowerCase() === 'a' ? 'approve' : e.key.toLowerCase() === 'v' ? 'veto' : null;
  if (action) { e.preventDefault(); $(action).click(); }
});
const events = new EventSource('/events');
events.addEventListener('snapshot', e => {
  connected = true; snapshot = JSON.parse(e.data); $('connection').textContent = '● Connected'; $('connection').classList.add('online'); render();
});
events.onerror = () => { connected = false; $('connection').textContent = 'Reconnecting…'; $('connection').classList.remove('online'); render(); };
window.addEventListener('pagehide', () => events.close());
render();
