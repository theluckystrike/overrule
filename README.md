# Overrule

A local moderation court for Twitch chat.
Built from an empty repository with OpenAI Codex for the Codex x TwitchCon Hackathon.
No TapVow code or package is used.

## Current build

This build includes the day 1 to day 5 offline court.
It includes a command parser, rate limits, a case engine, a durable JSONL journal and a fixture replay source.
The 1080p overlay shows the case, weighted vote, countdown and gavel.
Live OAuth and EventSub remain disabled interfaces.
The simulator uses synthetic accounts and a simulated streamer approval.
The browser connects only to the local server. No Twitch requests are sent.

## Setup

Use Node.js 22.18 or later in the Node 22 line.
Node runs the TypeScript source directly. The simulator and unit tests need no package install.
The optional type check needs the development packages.

Check disk space and memory before installs and tests on this Mac.
Do not continue below 20 GB available or 25 percent free memory.

```sh
df -g /System/Volumes/Data
memory_pressure | tail -1
npm ci --ignore-scripts
npm run check
```

The lock file pins the three development packages. The installed packages use about 25 MB.

```sh
df -g /System/Volumes/Data
memory_pressure | tail -1
npm test
npm run sim
```

Open [the overlay](http://localhost:3000/overlay) after starting the simulator.
The first connected page starts the fixture automatically.
One command drives the case card, votes, a 25-second countdown, a simulated approval and the gavel.
The server stays open. Stop it with Ctrl+C.
The overlay has a transparent background for OBS. Set the browser source to 1920 by 1080.
The app uses local files only. No CDN or build step is needed.

Each simulator process gets a new journal under data/demo-*.jsonl.
The fixture uses fresh event IDs for each run and retains its duplicate-delivery test.
The server binds to loopback on port 3000. Run one server at a time.
Each state change and vote adds an audit record. The /cases endpoint returns the current state.
SSE sends full snapshots and reconnects automatically. A reconnect does not strike the same gavel again.

## Operator mode

For manual approval, stop the simulator and run the following command.

```sh
npm run dev
```

Open [the operator page](http://localhost:3000/operator).
Select Start fixture. Keep the operator page focused for keys.
Open the overlay in another tab or OBS.

| Key | Action |
| --- | --- |
| Space | Close voting early |
| A | Approve the jury result |
| V | Veto the action |

With no jury result, A explicitly approves a timeout intent.
V records no action. Veto wins if A and V arrive within the 300 millisecond decision window.
After the ruling, the gavel plays once and the two-minute appeal window begins.
A new fixture can start after the case closes.
The operator page shows voter names, weights and changed votes.
Controls require the current case ID and a page token from the same local origin.
Manual mode restores data/operator-audit.jsonl. Demo mode never turns on live actions.
During the appeal window, select Simulate accused appeal. Then select Uphold ruling or Overturn ruling.
The button is for offline tests. A live appeal must come from the accused in chat.
Open [the docket](http://localhost:3000/docket) to see cases, votes, actions and consistency.
Live Twitch chat is still future work.

## Commands

| Command | Meaning |
| --- | --- |
| `!case @login reason` | A mod opens a case on that user's latest message |
| `!report message-id reason` | A viewer reports a recent message |
| `!report reason` in a reply | A viewer reports the reply target |
| `!guilty [case-id]` | Vote guilty |
| `!notguilty [case-id]` | Vote not guilty |
| `!vote guilty [case-id]` | Alternate vote form |
| `!appeal` | The accused requests an appeal |
| `!docket` | Return the local case endpoint hint |

A case ID is required when more than one case is voting.
The parser accepts at most five commands per user in ten seconds.
Messages expire from the ingest cache after two minutes.
The live adapter must supply authenticated Twitch event badges and IDs.

## Case rules

The state path is open, evidence, voting, awaiting_approval, ruling, appeal_window and closed.
Voting lasts 25 seconds. The server advances timers four times per second.
Tests use a virtual clock so they do not wait for real deadlines.
Only one case can stay open per accused user.
An accused user cannot vote in that case.
One vote per user counts. A new vote replaces it and records the change.
Mods and the broadcaster have weight three. Other viewers have weight one.
Quorum requires three distinct people. A tie has no jury result.
More than 40 new voters in ten seconds marks a case as contested.
Manual mode requires explicit streamer approval. AUTO_ACTIONS is not enabled.
Only npm run sim supplies a clearly labelled synthetic approval.
An innocent ruling acts as a veto and has no timeout intent.
The maximum timeout intent is 600 seconds. Old messages cannot produce a timeout.
The default Helix adapter records dry run actions. It makes no Twitch request.
A separate HTTP adapter is tested against a local fake Helix server.
Each accused user has one appeal per stream. The appeal window is two minutes.
An appeal needs a streamer ruling. An overturn changes the final precedent verdict.

## Storage and limits

This tool holds chat text on local disk. Do not use it with real viewer data yet.
The journal stores full case snapshots and operation IDs. It restores both after restart.
Writes are flushed before the in-memory index changes. Invalid or partial records stop startup.
Use one process per journal. There is no cross-process lock or journal compaction yet.
Closing a case clears text from its current snapshot. Earlier audit records still hold that text.
The planned appeal-window text purge and 14-day retention tool are not implemented.
No production privacy or retention gate has passed.

Nearest precedent uses word overlap on stored rule labels.
Simple keywords select spam, harassment or links. Other reasons use channel-conduct.
The optional model writes neutral charge text and selects a supplied precedent.
It cannot change the rule, verdict, vote weight or timeout duration.
Consistency measures agreement among closed case pairs with the same rule.
It returns no score when there are no comparable pairs.

## Helix actions and appeals

A guilty ruling records a timeout request before it sends one verdict.
The timeout limit is 600 seconds. No permanent ban or message deletion is available.
The action log records pending, sent, failed or unknown status and the adapter mode.
A dry run marked sent means that a local simulation completed.
A fake result means that the local fake server accepted the request.
Neither is evidence of a real Twitch action.

The client checks both HTTP status and chat delivery status.
It uses a four-second network deadline and does not retry writes automatically.
A saved pending action becomes unknown after restart. It is not sent again.
An owner must check an unknown result in Twitch before any manual recovery.
There is no operator retry button yet.

An overturn updates the final precedent and requests removal of the owned timeout.
The client compares the saved receipt with the current timeout before removal.
It refuses to remove a changed timeout or a permanent ban.
An expired timeout needs no removal. The docket keeps the release result separate from the ruling.
An upheld appeal keeps the original verdict and sends one appeal update.

The live factory is createLiveHelix in src/helix.ts.
It needs an explicit owner gate, a broadcaster OAuth token provider and matching broadcaster and moderator IDs.
The default CLI does not enable it. DRY_RUN=0 stops with an owner-needed message.
OAuth and the real EventSub adapter must be finished before the live gate can open.

## Model and fallback

The default is deterministic and needs no model key.
Rule keywords select a neutral charge and the nearest closed precedent.
Fallback advice appears at once. The vote loop never waits for a model response.

To enable optional model advice later, set MODEL_ENABLED=1, OPENAI_MODEL and OPENAI_API_KEY in the process environment.
Do not put a key in this repository.
Use a model that supports strict structured output for Chat Completions.
The model request sends the reported text, reason, rule and a short list of closed precedents.
It sends no credentials or voter names in the prompt.

The response must match a strict JSON schema and pass local checks.
The client makes at most two attempts with a four-second deadline per attempt.
Missing keys, refusals, invalid output, timeouts and service errors use the deterministic fallback.
An invented precedent ID is rejected.
No paid model call was made during this build.

To check the missing-key loop, run the following command and open the overlay.

```sh
OPENAI_API_KEY= MODEL_ENABLED=1 npm run sim
```

The optional browser check runs the fake Helix and appeal flow with an empty key.
Check disk and memory first. It uses the approved sprint browser on CDP port 9252.

```sh
OPENAI_API_KEY= MODEL_ENABLED=1 OPENAI_MODEL=test-only node scripts/verify-day45.mjs
```

G5 passed without a model key. The local fake-server action checks passed.
G4 still needs a real timeout on the owner test channel.

## Twitch setup later

Register the app and save the credentials in the external secrets file named in the sprint plan.
The optional loader reads ~/yc-w27-work/.secrets/twitch-app.json only when called.
A missing file returns no credentials. Invalid input returns a generic error.
Imports, the simulator, tests and local server do not read the secrets file.
Never paste credentials into this repository or a log.

Live work still needs OAuth state checks, token refresh, secure token storage, WebSocket subscriptions, reconnect handling and revocation handling.
The planned scopes are `user:read:chat`, `user:write:chat` and `moderator:manage:banned_users`.
The live gate must show one real channel message. The later action gate must show one approved test-account timeout.
Neither live gate has passed in this build.
The owner must use the broadcaster account for the current timeout ownership check.

## Build record

Tests were written before the engine implementation.
All 43 unit and HTTP tests and the TypeScript check passed on 26 October 2026.
The 1080p browser check showed card, voting, result and gavel without a refresh.
The operator browser check confirmed Space, A and V, including veto precedence.
The day 4 and day 5 browser check showed a fake timeout, appeal release and a changed consistency score.
Screenshots are in docs/screenshots.
The optional browser checks in scripts use the sprint browser on CDP port 9252.
Each browser check starts its own local server and closes its own tab when done.
Validation results are recorded in docs/codex-log.md and the lane report.
Do not use the plan's full-product submission claims until the corresponding work is complete.

Codex session ID `01a17712-fe31-70e0-a11c-9b80e5183106`.

## API references

The HTTP client follows the [Twitch Helix reference](https://dev.twitch.tv/docs/api/reference/).
Timeout requests always include a duration. Appeal removal checks the current timeout first.
The model request uses the [OpenAI structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs).
