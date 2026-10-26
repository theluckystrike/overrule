# Chat fixture

chat.jsonl records seven synthetic EventSub-shaped notifications.
These events did not come from a Twitch channel.
All names and IDs are test values.
The stream clock starts on 26 October 2026 at midnight UTC.

The sequence contains one target message, a mod command, three jurors, a vote change and a duplicate delivery.
The final jury has three people and a guilty weight of five.
Replay uses event timestamps so the fixture does not become stale over time.
