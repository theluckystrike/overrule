const $ = id => document.getElementById(id);
function element(tag, text, className) { const e = document.createElement(tag); e.textContent = text; if (className) e.className = className; return e; }
function render(s) {
  $('consistency').textContent = s.consistency === null ? 'No comparable cases yet' : `${Math.round(s.consistency * 100)}% agreement`;
  $('mode').textContent = `Action mode ${s.actionMode}. ${s.cases.length} cases on record.`;
  $('cases').replaceChildren(...s.cases.slice().reverse().map(c => {
    const card = element('article', '', 'operator-case');
    card.append(element('span', `CASE ${c.id.slice(0, 8)} · ${c.state.replaceAll('_', ' ')}`, 'eyebrow'), element('h2', `@${c.message.login} · ${c.state === 'expired' ? 'Ruling expired. No action' : c.verdict === 'guilty' ? 'Guilty' : c.verdict ? 'No action' : 'Awaiting ruling'}`), element('p', c.message.text || 'Message hidden after the appeal window'));
    card.append(element('p', `Rule ${c.rule}. ${c.analysis?.charge ?? c.reason}. Advice from ${c.analysis?.source ?? 'rule checks'}.`));
    card.append(element('p', c.analysis?.precedentId ? `Cited precedent ${c.analysis.precedentId}` : 'No earlier precedent cited'));
    if (c.appealed) card.append(element('p', c.state !== 'closed' ? 'Appeal awaiting streamer review' : c.overturned ? 'Appeal overturned the ruling' : 'Appeal upheld the ruling'));
    const votes = element('ul', '');
    for (const v of Object.values(c.votes)) votes.append(element('li', `${v.name} · ${v.choice === 'guilty' ? 'Guilty' : 'Not guilty'} ×${v.weight}${v.changed ? ' · Changed' : ''}`));
    card.append(votes);
    const actions = element('ul', '');
    for (const [name, effect] of Object.entries(c.effects ?? {})) actions.append(element('li', `${name} · ${effect.mode} · ${effect.status}${effect.detail ? ` · ${effect.detail}` : ''}`));
    card.append(actions); return card;
  }));
}
const events = new EventSource('/events');
events.addEventListener('snapshot', e => { $('connection').textContent = '● Connected'; $('connection').classList.add('online'); render(JSON.parse(e.data)); });
events.onerror = () => { $('connection').textContent = 'Reconnecting…'; $('connection').classList.remove('online'); };
window.addEventListener('pagehide', () => events.close());
