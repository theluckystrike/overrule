# Overrule

A local moderation court for Twitch chat.
Built from an empty repository with OpenAI Codex for the Codex x TwitchCon Hackathon.
No TapVow code or package is used.

## Current build

This is the day 1 and day 2 offline foundation.
It includes a command parser, rate limits, a case engine, a durable JSONL journal and a fixture replay source.
Live OAuth and EventSub are disabled interfaces. The overlay and live moderation are not built yet.
The simulator uses synthetic accounts and a simulated streamer approval. It sends no network requests.

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
npm run dev
```

The simulator writes data/sim-audit.jsonl and exits.
Each state change and each vote adds one JSONL audit record.
Repeat runs reuse operation IDs and do not create another case.
The local server binds to loopback on port 3000.
Open the root page or /cases to read the snapshot loaded at server startup.
Run the simulator before the server. There is no live overlay or SSE yet.

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
Voting lasts 25 seconds. The host must call tick to advance timers.
The simulator supplies a virtual clock. A later live host must schedule tick.
Only one case can stay open per accused user.
An accused user cannot vote in that case.
One vote per user counts. A new vote replaces it and records the change.
Mods and the broadcaster have weight three. Other viewers have weight one.
Quorum requires three distinct people. A tie has no jury result.
More than 40 new voters in ten seconds marks a case as contested.
Every ruling requires explicit streamer approval. AUTO_ACTIONS is not enabled.
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
All 21 unit tests and the TypeScript check passed on 26 October 2026.
The offline replay completed. A second replay kept the same case and all 11 audit records.
Validation results are recorded in docs/codex-log.md and the lane report.
Do not use the plan's full-product submission claims until the corresponding work is complete.

Codex session ID `01a17712-fe31-70e0-a11c-9b80e5183106`.
