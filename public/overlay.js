const $ = id => document.getElementById(id);
let snapshot;
let offset = 0;
let lastGavel = sessionStorage.getItem('overrule-gavel');
const names = { open: 'Case opened', evidence: 'Evidence review', voting: 'Voting open', awaiting_approval: 'Streamer decision', ruling: 'Ruling delivered', appeal_window: 'Appeal window', closed: 'Case closed', expired: 'Ruling expired' };
function render(s) {
  snapshot = s;
  $('source-mode').textContent = s.liveSource ? `TWITCH · ${s.actionMode.toUpperCase()}` : 'OFFLINE DEMO';
  offset = s.now - Date.now();
  const c = s.current;
  $('idle').hidden = !!c; $('case-card').hidden = !c;
  if (!c) return;
  $('case-number').textContent = `CASE ${c.id.slice(0, 8).toUpperCase()}`;
  $('phase').textContent = names[c.state];
  $('accused').textContent = `@${c.message.login}`;
  $('message').textContent = c.message.text || (c.message.deleted ? 'Evidence removed by moderation.' : 'Evidence hidden. Operator review required.');
  $('reason').textContent = c.analysis?.charge || c.reason || `Review of ${c.rule}`;
  const votes = Object.values(c.votes);
  const guilty = votes.filter(v => v.choice === 'guilty').reduce((n, v) => n + v.weight, 0);
  const innocent = votes.filter(v => v.choice === 'notguilty').reduce((n, v) => n + v.weight, 0);
  $('guilty').textContent = guilty; $('innocent').textContent = innocent;
  $('guilty-bar').style.width = `${100 * guilty / (guilty + innocent || 1)}%`;
  $('innocent-bar').style.width = `${100 * innocent / (guilty + innocent || 1)}%`;
  $('quorum').textContent = `${votes.length} jurors · ${votes.length < 3 ? 'Three needed for a jury result' : 'Quorum reached'}`;
  const jury = c.jury === 'guilty' ? 'Guilty' : c.jury === 'notguilty' ? 'Not guilty' : 'No jury result';
  $('status').textContent = c.state === 'voting' ? 'One person. One vote. You can change your mind.' : c.state === 'awaiting_approval' ? `${jury} · Waiting for ${s.autoApprove ? 'simulated ' : ''}streamer approval` : c.state === 'appeal_window' ? 'A mod can file !appeal @login for the accused.' : c.state === 'expired' ? 'Ruling expired. No action.' : 'A ruling is a precedent. An appeal can change it.';
  $('contested').hidden = !c.contested;
  $('verdict').hidden = !c.verdict;
  $('verdict-text').textContent = c.verdict === 'guilty' ? 'Guilty' : 'No action';
  const effect = c.overturned ? c.effects?.release : c.effects?.timeout;
  $('verdict-note').textContent = c.overturned ? `Appeal overturned · ${effect?.status === 'sent' ? 'Timeout released' : 'See the docket for action status'}` : c.verdict === 'guilty' ? `${s.actionMode === 'dry-run' ? 'Dry run' : 'Timeout'} · ${effect?.status ?? 'pending'}` : 'No timeout action';
  $('case-hint').textContent = s.cases.filter(c => c.state === 'voting').length > 1 ? `Add case ID ${c.id}` : '';
  if (s.gavel && lastGavel !== c.id) {
    lastGavel = c.id; sessionStorage.setItem('overrule-gavel', c.id);
    $('gavel').classList.remove('strike'); void $('gavel').offsetWidth; $('gavel').classList.add('strike');
    $('gavel').dataset.strikes = String(Number($('gavel').dataset.strikes || 0) + 1);
  }
  countdown();
}
function countdown() {
  const c = snapshot?.current;
  $('timer').textContent = c?.state === 'voting' ? Math.max(0, Math.ceil((c.deadline - Date.now() - offset) / 1000)) : '—';
}
const events = new EventSource('/events');
events.addEventListener('snapshot', event => {
  $('connection').textContent = '● Connected'; $('connection').classList.add('online');
  render(JSON.parse(event.data));
});
events.onerror = () => { $('connection').textContent = 'Reconnecting…'; $('connection').classList.remove('online'); };
setInterval(countdown, 200);
window.addEventListener('pagehide', () => events.close());
