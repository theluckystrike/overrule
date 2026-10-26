import { pathToFileURL } from 'node:url';
import { Journal } from './precedent.ts';
import { CaseEngine } from './case.ts';
import { Ingest, normalize } from './ingest.ts';
import { FakeEventSub } from './eventsub.ts';
import { DryRunActions } from './twitch.ts';

export async function simulate(path = 'data/sim-audit.jsonl'): Promise<CaseEngine> {
  const engine = new CaseEngine(new Journal(path), 'fixture-stream');
  const ingest = new Ingest(engine, 'channel-test');
  const source = new FakeEventSub(new URL('../fixtures/chat.jsonl', import.meta.url));
  let clock = 0;
  await source.start(raw => {
    const event = normalize(raw);
    if (!event) throw new Error('Fixture contains an invalid chat envelope');
    clock = event.at;
    const result = ingest.accept(event, clock);
    if (!result.ok) throw new Error(result.detail);
  });
  const actions = new DryRunActions();
  for (const c of engine.list()) {
    if (c.state === 'voting') engine.tick(c.deadline!);
    clock = c.deadline! + 1;
    if (engine.get(c.id).state === 'awaiting_approval') engine.decide(`sim-approve-${c.id}`, c.id, 'guilty', true, clock);
    if (engine.get(c.id).state === 'ruling') {
      await actions.timeout(c.id, c.message.userId, 600);
      await actions.postVerdict(c.id, 'Synthetic jury result approved by simulated streamer');
      engine.advance(`sim-window-${c.id}`, c.id, 'appeal_window', clock + 1);
    }
    if (engine.get(c.id).state === 'appeal_window') engine.tick(clock + 120001);
  }
  console.log('Offline replay complete. All people and approvals are synthetic. No Twitch actions were sent.');
  console.log(JSON.stringify(engine.list().map(c => ({ id: c.id, state: c.state, jury: c.jury, verdict: c.verdict, votes: Object.keys(c.votes).length }))));
  return engine;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  simulate().catch(() => { console.error('Simulation failed. Check fixture and journal integrity'); process.exitCode = 1; });
}
