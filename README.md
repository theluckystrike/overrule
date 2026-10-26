# Overrule

A moderation court for Twitch chat, with visible votes, streamer review and an appeal record.

Built from an empty repository with OpenAI Codex for the Codex x TwitchCon Hackathon.
The current build runs locally with synthetic chat and dry run actions.
**Live OAuth and EventSub are not implemented. No real Twitch timeout has been verified.**

![Overrule showing a dry run ruling](docs/screenshots/day3-ruling.png)

## Try the offline demo

Use Node.js 22.18 or later in the Node 22 line.
No Twitch account, model key or package install is needed for the simulator.
Clone this repository, enter its folder and run the following command.

```sh
npm run sim
```

Open [the overlay](http://localhost:3000/overlay).
The first connected page starts the fixture.
It shows one case, three synthetic jurors, a 25-second vote, a simulated approval and a gavel.
The server stays open. Stop it with Ctrl+C.
Run only one server at a time.

For OBS, use the overlay URL as a browser source at 1920 by 1080.
The background is transparent. The browser layout has been checked at that size.
An actual OBS and Twitch stream rehearsal is still needed.

## Run modes

| Mode | Command or entry point | Behavior |
| --- | --- | --- |
| Automatic demo | `npm run sim` | Fixture starts when a page connects. Approval is synthetic. Actions are dry runs |
| Manual court | `npm run dev` | Start the fixture on the operator page. A key press is required for the ruling |
| Missing model key | `OPENAI_API_KEY= MODEL_ENABLED=1 npm run sim` | The loop uses deterministic advice |
| Fake Helix tests | `npm test` | Tests send HTTP requests to a local fake server |
| Live Helix adapter | `createLiveHelix` in src/helix.ts | Requires an explicit owner gate and a broadcaster OAuth provider. Not enabled by the CLI |

Setting DRY_RUN=0 stops the current CLI with an owner-needed message.
It does not connect the app to Twitch.
AUTO_ACTIONS does not enable real moderation.

## Pages and controls

| Page | Purpose |
| --- | --- |
| [Overlay](http://localhost:3000/overlay) | Case card, weighted votes, countdown and gavel |
| [Operator](http://localhost:3000/operator) | Fixture start, keys and appeal review |
| [Docket](http://localhost:3000/docket) | Cases, public votes, action status, precedent and consistency |
| [Case data](http://localhost:3000/cases) | Current JSON snapshot |

The root page opens the operator desk.
The server binds to loopback on port 3000.
SSE sends full snapshots and reconnects automatically.
The gavel does not repeat when the same ruling reconnects or reloads.

In manual mode, select Start fixture and keep the operator page focused.

| Key | Action |
| --- | --- |
| Space | Close voting early |
| A | Approve the jury result |
| V | Veto the action |

With no jury result, A explicitly approves a timeout intent.
Veto wins if A and V arrive within the 300 millisecond decision window.
During the appeal window, select Simulate accused appeal, then Uphold ruling or Overturn ruling.
That button is an offline stand-in for the accused. A live appeal must come from the accused in chat.
A new fixture can start after the current case closes.

## Case rules

- One active case per accused user.
- One vote per user. A changed vote replaces the earlier vote.
- Viewer weight one. Mod and broadcaster weight three.
- No vote from the accused in their own case.
- Three distinct jurors are required. A tie has no jury result.
- More than 40 new voters in ten seconds marks the vote as contested.
- Manual mode requires streamer approval. Model advice never authorizes an action.
- Timeout requests are capped at 600 seconds. Messages older than two minutes cannot trigger a new timeout.
- No permanent ban or message deletion action.
- One appeal per stream ID, with a two-minute request window. The current local runtime creates a stream ID for each process.

The parser supports `!case @login reason`, `!report message-id reason`, reply reports, `!guilty`, `!notguilty`, `!vote guilty`, `!appeal` and `!docket`.
Include the case ID on a vote when more than one case is voting.
The parser allows five commands per user in ten seconds.
There is no live chat connection in the shipped modes. Fixtures drive these commands.

## Actions, appeals and precedent

The Helix interface has a default dry run client and an HTTP client.
Tests cover timeout, verdict chat and owned-timeout removal against a local fake server.
The HTTP client checks response status and chat delivery status.

The journal records an action before the request starts.
It then records sent, failed or unknown status with the adapter mode.
Sent in dry run mode means only that a local simulation completed.
Fake mode means the local fake server accepted the request.
Neither is proof of a Twitch action.

HTTP requests have a four-second deadline. Writes are not retried automatically.
A saved pending action becomes unknown after restart and is not sent again.
An owner must check the channel before any manual recovery.
There is no recovery button yet.

An overturn changes the final precedent and requests removal of the owned timeout.
The HTTP client compares the current timeout with its saved receipt first.
It refuses to remove a changed timeout or permanent ban.
The docket shows the ruling and release result separately.

Consistency is the share of closed case pairs with the same rule and the same final verdict.
An overturn changes that final verdict. There is no score when no comparable pair exists.
The score is a record of agreement, not a claim that a ruling was correct.

## Model advice and fallback

The default is deterministic and needs no key.
Simple rule keywords choose neutral charge text and a matching closed precedent.
The optional model writes charge text and selects from supplied precedent IDs.
It cannot change the rule, verdict, vote weight or timeout duration.

To enable it later, set MODEL_ENABLED=1, OPENAI_MODEL and OPENAI_API_KEY in the process environment.
Use a model that supports strict structured output for Chat Completions.
Never put a key in this repository.
The request sends the reported text, reason, rule and selected precedent records to the model service.

Fallback advice appears at once. Voting does not wait for the model.
Each model attempt has a four-second deadline. There is at most one retry.
Missing keys, refusals, invalid output and service errors keep the fallback.
Invented precedent IDs are rejected.
No paid model call was made during the recorded build. The live model path has not been verified.

## Twitch app setup

These steps prepare the app registration. They do not enable the unfinished live path.

1. Enable two-factor authentication in [Twitch security settings](https://www.twitch.tv/settings/security) if needed.
2. Open the [developer console](https://dev.twitch.tv/console/apps) and register an app.
3. Use Overrule as the name if available. Select Chat Bot as the category.
4. Add `http://localhost:3000/auth/callback` as the planned OAuth redirect URL.
5. Save the client ID and secret to `~/yc-w27-work/.secrets/twitch-app.json` using the shape below.

```json
{
  "client_id": "REPLACE_LOCALLY",
  "client_secret": "REPLACE_LOCALLY",
  "redirect_uri": "http://localhost:3000/auth/callback"
}
```

Protect the external folder and file after saving them.

```sh
chmod 700 ~/yc-w27-work/.secrets
chmod 600 ~/yc-w27-work/.secrets/twitch-app.json
```

The loader handles an absent file without exposing credentials.
Imports, tests and the default runtime do not read it.
The live factory reads it only when explicitly called after the owner gate opens.
The client secret is not a user access token.

The planned user-token scopes are `user:read:chat`, `user:write:chat` and `moderator:manage:banned_users`.
The current live Helix factory requires matching broadcaster and moderator IDs for its timeout ownership check.
Use the broadcaster test account when that path is ready.

OAuth state checks, token storage, refresh and real EventSub delivery still need implementation.
The registered callback route and a working /auth route are not present yet.
After that work, the owner must authorize the account and verify a real chat message, timeout and appeal removal.
Keep live actions disabled until those gates are reviewed.

## Tests and build evidence

The latest recorded verification passed **43 unit and HTTP tests** and the TypeScript check on 26 October 2026.
No tests were rerun for this documentation-only revision.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The lock file pins three development packages. The installed set used about 25 MB on the build Mac.
Unit tests use Node's built-in runner and need no development package install.
The type check needs the development packages.

Browser checks verified the 1080p vote loop, operator keys, SSE recovery, appeals and the docket.
The fake-server browser flow also passed with an empty model key.
The optional scripts use the sprint browser on CDP port 9252 and close their own tabs.

```sh
node scripts/verify-browser.mjs
node scripts/verify-operator.mjs
OPENAI_API_KEY= MODEL_ENABLED=1 OPENAI_MODEL=test-only node scripts/verify-day45.mjs
```

On the build Mac, run the following checks before an install, test or browser run.
Do not proceed below 20 GB available or 25 percent free memory.

```sh
df -g /System/Volumes/Data
memory_pressure | tail -1
```

See [the build log](docs/codex-log.md), [the docket screenshot](docs/screenshots/day45-docket.png) and the tests in test/.
The repository began empty. No TapVow source or package was used.

Codex session ID `01a17712-fe31-70e0-a11c-9b80e5183106`.

## Storage and limits

This is a local prototype. Use synthetic messages and test accounts.
It holds chat text on disk. Closing a case clears text from the current snapshot, but older audit records retain it.
The appeal-window text purge and 14-day retention tool are not implemented.

Each automatic demo process writes a fresh data/demo-*.jsonl journal.
Manual mode restores data/operator-audit.jsonl.
Writes are flushed before the memory index changes. Invalid or incomplete records stop startup.
Use one process per journal. There is no cross-process lock, compaction or journal size limit.
Long-session chat pacing and manual recovery still need work.

There is no hosted service, real-channel verification, OBS rehearsal or verified user-impact claim.
G2 and G3 passed offline. G5 passed with no model key.
G1 and G4 remain open for real Twitch chat and an approved real timeout.

## Owner finish steps

Complete Twitch 2FA and app registration if needed.
After the live code is ready, authorize the test account and verify the live gates.
Run a short Twitch test stream and record the app functioning there.
Record the Codex build thread. Publish the repository and upload a public YouTube video under three minutes.
Complete the Devpost form, submit as an individual and save the confirmation.
No publication or submission has been performed by this build thread.

## References and license

The API adapters follow the [Twitch Helix reference](https://dev.twitch.tv/docs/api/reference/) and the [OpenAI structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs).
Submission requirements are in the [official hackathon rules](https://twitchcon-codex.devpost.com/rules).

[MIT license](LICENSE).
