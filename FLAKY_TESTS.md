# Flaky end-to-end tests

Written by `npm run test:e2e` (scripts/e2e/run.mjs) from the last full pass^3 run on 2026-11-26. A case that failed some runs and passed others is listed here with its evidence; it is quarantined for investigation, never retried until it passes.

None in the last full run.

## History

- conv/send-while-pending-button: passed 2 of 3 on 2026-11-26 (run of aaa27e1).
### Investigation (2026-11-26, lead)

- Cause: harness timing, not product behaviour. Trace run-1: the fake reply arrived at 4,978 ms, the harness typed "Second question" at 5,227 ms, so the send button was correctly enabled again when checked. The 1.5 s fake delay was shorter than typing time under 6-way parallel load.
- Fix: the fake reply now waits 8 s (scripts/e2e/cases.mjs). Re-proven by the next full pass^3 run below; the case leaves quarantine only if it passes all 3 runs.
- Result: passed 3 of 3 in the next full run (264/264 x 3); released from quarantine.
