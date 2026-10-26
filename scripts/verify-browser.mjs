// Uses only the sprint's existing CDP browser. Closes only the tab it creates.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { VoteLoop } from '../src/loop.ts';
import { createApp } from '../src/server.ts';
const loop = new VoteLoop({ autoApprove: true });
const app = createApp(loop, { autoStart: true });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const target = await (await fetch('http://127.0.0.1:9252/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let next = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  const p = pending.get(message.id);
  if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const wait = async expression => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()-start>40000){clearInterval(timer);reject(new Error('Browser gate timed out'))}},100)})`);
try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/overlay` });
  await wait("document.getElementById('guilty')?.textContent === '5'");
  const ratio = await evaluate('innerWidth / 1920');
  if (ratio !== 1) await send('Emulation.setDeviceMetricsOverride', { width: Math.round(1920 / ratio), height: Math.round(1080 / ratio), deviceScaleFactor: ratio, mobile: false });
  const voting = await evaluate(`({phase:document.getElementById('phase').textContent,timer:document.getElementById('timer').textContent,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollHeight>innerHeight})`);
  assert.equal(voting.width, 1920); assert.equal(voting.height, 1080);
  assert.equal(voting.phase, 'Voting open'); assert.equal(voting.overflow, false);
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('docs/screenshots/day3-voting.png', Buffer.from(shot.data, 'base64'));
  await wait("document.getElementById('gavel')?.dataset.strikes === '1'");
  const ruling = await evaluate(`({phase:document.getElementById('phase').textContent,verdict:document.getElementById('verdict-text').textContent,overflow:document.documentElement.scrollHeight>innerHeight,bottom:document.querySelector('.court').getBoundingClientRect().bottom})`);
  assert.equal(ruling.verdict, 'Guilty'); assert.equal(ruling.overflow, false);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('docs/screenshots/day3-ruling.png', Buffer.from(shot.data, 'base64'));
  app.server.closeAllConnections();
  await wait("document.getElementById('connection')?.textContent === 'Reconnecting…'");
  await wait("document.getElementById('connection')?.textContent === '● Connected'");
  assert.equal(await evaluate('document.getElementById("gavel").dataset.strikes'), '1');
  // Reload restores the current state without striking the same gavel twice.
  await send('Page.reload');
  await wait("document.getElementById('connection')?.textContent === '● Connected'");
  assert.equal(await evaluate('document.getElementById("gavel").dataset.strikes || "0"'), '0');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ gate: 'G3 passed', voting, ruling, browserErrors: errors }));
} finally {
  ws.close();
  await fetch(`http://127.0.0.1:9252/json/close/${target.id}`);
  await app.stop(); loop.dispose();
}
