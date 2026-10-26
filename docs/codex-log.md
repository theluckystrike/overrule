# Codex build log

## 26 October 2026

Session `01a17712-fe31-70e0-a11c-9b80e5183106`.
Lane TWITCH-BUILD. Account codex-pro as assigned by the owner.

The owner requested the day 1 and day 2 work that needs no Twitch credentials.
The prompt required a new repository, an ingest layer, a case engine, a JSONL store, fixture replay, tests, setup instructions, a local commit and a lane report.

Read the sprint rules and the Twitch plan before implementation.
Started from an empty project directory. Initialized a fresh local git repository.
Wrote tests before the case engine.
Built the offline foundation in this one thread. No other agent wrote code.
Saved the thread ID from CODEX_THREAD_ID to the requested session file.
Did not open or print the Twitch credentials file.
Did not copy TapVow source, connect a remote, push code or make paid calls.

## Validation status

The disk gate cleared after the first ten-minute wait.
The initial disk check showed 19 GB available. A later check showed 18 GB.
The coldstore plan returned zero eligible items.
No install, type check, unit test, simulator run or browser was started below the gate.
At 07.28 UTC the disk check showed 21 GB available. Free memory was 69 percent.
Installed three development packages with scripts disabled. They use about 25 MB.
The TypeScript check passed. All 21 unit tests passed.
The fixture replay produced one closed case and 11 audit records.
A second replay kept the same case ID and the same 11 records.
The local HTTP snapshot returned the closed case.
Test teardown checked for open files and logged its deletion in the sprint manifest.
No test failures were observed. Do not claim a test-discovered bug in the submission story.

## Gates still open

G1 needs live OAuth, EventSub and one real channel message.
G2 passed for the offline foundation. Tests and the fixture replay completed.
The day 3 entry below records the overlay work. Live Helix actions remain later-day work.
The final submission text must describe only work that has passed its gate.

## Day 28 Oct work

Completed ahead of schedule on 26 October 2026 in the same Codex thread.
The owner requested the overlay, vote loop, operator keys, simulator and tests.
No Twitch credentials were used. No other agent wrote code.

Added the 1080p overlay with a case card, weighted bars, a countdown and a gavel.
Added SSE snapshots and reconnect status.
Added the operator page with Space, A and V.
A 300 millisecond decision window gives veto priority over an approval in the same burst.
Added a paced fixture replay with fresh event IDs and current timestamps.
The simulator starts when its first page connects. It supplies only synthetic approval.
Manual mode keeps approval with the operator.
The case engine did not need changes.

All 27 unit and HTTP tests passed. The TypeScript check passed.
The first full npm run sim browser check reached the gavel without a refresh.
At 1920 by 1080 the card fit inside the frame with no overflow.
The operator browser check used Space, A and V and confirmed no action after veto.
Screenshots are saved in docs/screenshots.

The first network-drop harness used Chrome offline emulation.
That did not close the existing SSE connection and the harness timed out.
The revised harness closes the test server connections to cause a real stream drop.
This is a test harness change. Do not claim it as a product bug fix.

Disk checks showed 20 to 22 GB available during verification.
Free memory stayed at or above 65 percent.
No package install or paid call was needed.
Only the approved CDP browser on port 9252 was used.
Each browser check closed its own tab and left other tabs alone.

The remaining live gates still need OAuth, real EventSub and a real test-channel timeout.
Retention, appeal controls and the full docket remain future work.

The revised stream-drop check passed. EventSource reconnected after the server closed its connections.
The case snapshot returned and the gavel did not repeat.
The browser harness normalizes only its own tab to account for the shared browser zoom.
It checks a 1920 by 1080 layout without changing the shared profile.
G3 passed for the offline simulator. No manual refresh was needed for the court loop.

## Day 29 and 30 Oct work

Completed ahead of schedule on 26 October 2026 in the same Codex thread.
The owner requested Helix actions, appeal and docket flows, a model fallback, consistency and tests.
Used the OpenAI Docs skill and the official Twitch reference to check request shapes.
No credentials file was opened. No paid model call or live Twitch call was made.

Added an injected Helix client and a local fake Helix HTTP server for tests.
Added timeout, verdict and owned-timeout removal requests.
Added durable action states and receipts. A restart does not resend an unconfirmed action.
Added operator appeal controls and a live local docket.
Added strict model output checks, a four-second per-attempt deadline, one retry and deterministic fallback.
Model advice cannot change the verdict, rule or timeout duration.
The default runtime stays in dry run mode. The live factory stays behind the owner gate.

All 43 unit and HTTP tests passed. The TypeScript check passed.
Tests cover each Helix request, dropped chat, errors, request deadlines and changed-ban protection.
Tests also cover restart recovery, model validation, missing keys, fallback, appeal outcomes and consistency.
The fake-server browser run approved two cases and overturned one.
The docket showed 0 percent agreement for the two same-rule cases with different final rulings.
That run used an empty model key and showed fallback advice.
The overlay browser check still reached the gavel at 1920 by 1080 without a refresh.

G5 passed with the model key gone.
The fake-server action gate passed. It is not the real G4 gate.
G1 and G4 still need OAuth, real EventSub and the owner test-channel checks.
The optional paid model path has only fake-response tests so far.

Disk checks showed 20 to 21 GB available. Free memory stayed at or above 61 percent.
No install was needed. Only the approved CDP browser was used.
The checks closed their own tabs and local servers.
