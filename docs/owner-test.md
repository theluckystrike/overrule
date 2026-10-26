# Owner test

Use the broadcaster test account and alt accounts. Do not use real viewers.
Set OVERRULE_EXPECTED_LOGIN to the test channel login on every run, including runs with a saved token. Real actions refuse to start without it.
If the saved account differs, read the login mismatch message and authorize the intended account on the local page.
Start with dry run actions.

```sh
OVERRULE_EXPECTED_LOGIN=your_test_login npm run live
```

Authorize the test account. Check the terminal line Connected to channel and its login.
Confirm a normal chat message, a reply report and operator promotion.
Check lead moderator immunity and Shared Chat guest exclusion. Guest broadcasters, moderators and viewers must not enter the court or vote. Check a delete event using a separate case.

Do not delete the target message during the timeout demonstration.
Deleted evidence causes an attempted ruling to become expired with no timeout.
A user clear has the same effect. Use a harmless target message and test accounts.
If a bot removes that message, wait for expiry or record no action, then start a fresh case.

After the dry run checks pass, enable actions explicitly.

```sh
OVERRULE_EXPECTED_LOGIN=your_test_login DRY_RUN=0 OVERRULE_LIVE_ACTIONS=1 npm run live
```

Open a fresh case. Cast three votes. Approve the jury result with A.
Check the Twitch mod log for the timeout.
File !appeal @login from a moderator account. Overturn it on the operator page.
Check the release in the mod log and docket. Keep both results in the recording.
Do not claim success if the release is refused or unconfirmed.

Capture the overlay in OBS at 1920 by 1080. Record the Codex thread separately.
Real Twitch and OBS verification remain owner steps. Mock tests do not prove these results.
