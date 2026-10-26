import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEventSub, LiveEventSub } from '../src/eventsub.ts';
import { DisabledOAuth } from '../src/auth.ts';
import { DryRunActions } from '../src/twitch.ts';

test('fixture source can be stopped without delivering more events', async () => {
  const source = new FakeEventSub(new URL('../fixtures/chat.jsonl', import.meta.url));
  let count = 0;
  await source.start(() => { count++; source.stop(); });
  assert.equal(count, 1);
  const abort = new AbortController(); abort.abort();
  await source.start(() => { count++; }, abort.signal);
  assert.equal(count, 1);
});
test('live adapters fail closed without credentials or network access', async () => {
  await assert.rejects(new LiveEventSub().start(() => {}), /configuration/);
  const auth = new DisabledOAuth();
  await assert.rejects(auth.authorizationUrl('state'), /not implemented/);
  await assert.rejects(auth.exchange('code', 'state'), /not implemented/);
  await assert.rejects(auth.accessToken(), /not implemented/);
});
test('dry run intents are bounded and deduplicated', async () => {
  const a = new DryRunActions();
  await assert.rejects(a.timeout('bad', 'u', 601), /between/);
  await assert.rejects(a.timeout('bad', 'u', 0), /between/);
  await a.timeout('case', 'u', 600); await a.timeout('case', 'u', 600);
  await a.postVerdict('case', 'Guilty'); await a.postVerdict('case', 'Guilty');
  assert.equal(a.intents.length, 2);
});
