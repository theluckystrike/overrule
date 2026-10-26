# Overrule

A local moderation court for Twitch chat.
Built from an empty repository with OpenAI Codex for the Codex x TwitchCon Hackathon.
No TapVow code or package is used.

## Current build

This build includes the day 1 to day 3 offline court.
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
Appeal resolution controls and live Twitch chat are still future work.

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
The action adapter only records dry run intents. It does not call Helix.
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
Model-based rule selection is future work.
Consistency measures agreement among closed case pairs with the same rule.
It returns no score when there are no comparable pairs.

## Twitch setup later

Register the app and save the credentials in the external secrets file named in the sprint plan.
The optional loader reads ~/yc-w27-work/.secrets/twitch-app.json only when called.
A missing file returns no credentials. Invalid input returns a generic error.
Imports, the simulator, tests and local server do not read the secrets file.
Never paste credentials into this repository or a log.

Live work still needs OAuth state checks, token refresh, secure token storage, WebSocket subscriptions, reconnect handling and revocation handling.
The planned scopes are `user:read:chat`, `user:write:chat` and `moderator:manage:banned_users`.
The live gate must show one real channel message. The later action gate must show one approved test-account timeout.
Neither gate has passed in this build.

## Build record

Tests were written before the engine implementation.
All 27 unit and HTTP tests and the TypeScript check passed on 26 October 2026.
The 1080p browser check showed card, voting, result and gavel without a refresh.
The operator browser check confirmed Space, A and V, including veto precedence.
Screenshots are in docs/screenshots.
The optional browser checks in scripts use the sprint browser on CDP port 9252.
Each browser check starts its own local server and closes its own tab when done.
Validation results are recorded in docs/codex-log.md and the lane report.
Do not use the plan's full-product submission claims until the corresponding work is complete.

Codex session ID `01a17712-fe31-70e0-a11c-9b80e5183106`.
