# Pi Goal Runner

Pi Goal Runner keeps a session working on a long-running objective until the user explicitly pauses, stops, or marks it complete. It is implemented as a Pi extension plus Pi-web status/action APIs and UI controls.

## Runtime locations

- Versioned source: `extensions/pi-goal-runner/index.ts`
- Installed extension: `~/.pi/agent/extensions/pi-goal-runner/index.ts`
- Extension enablement: `~/.pi/agent/settings.json`
- Persistent state: `~/.pi/agent/goal-runner.json`
- Last-known-good backup: `~/.pi/agent/goal-runner.json.bak`
- Cross-process store lock: `~/.pi/agent/goal-runner.json.lock`

The extension is loaded by both terminal Pi and Pi-web sessions. After changing the extension, copy it to the installed path and restart the relevant Pi-web service.

## Commands

Preferred short commands:

- `/g <objective>` — start a new goal, or append a subgoal when a goal already exists in the session.
- `/g-start <objective>` — explicitly start/replace a goal.
- `/g-add <subgoal>` — append a subgoal.
- `/g-status` — show current session goal status, retry timing, event window/returned count/top event types, and backup current-session coverage.
- `/g-list` — list active goals.
- `/g-subtasks` — list current goal subtasks.
- `/g-subtask-done <number|id>` — mark a subtask done.
- `/g-subtask-open <number|id>` — reopen a subtask as pending.
- `/g-subtask-block <number|id>` — mark a subtask blocked.
- `/g-events [type...]` — show recent Goal events, optionally filtered by event types such as `restore run` or `restore,run`; the title includes event window, returned count, and active filter.
- `/g-doctor` — show a one-shot diagnostic summary: config, store, backup, lock, current goal, retry, event summary top types, and recent events.
- `/g-lock` — show the Goal store lock path, free/held/stale status, age, and owner pid.
- `/g-unlock` — clear only a stale Goal store lock; held/non-stale locks are never removed.
- `/g-backup` — show backup readability, age, size, session count, whether it contains the current session, and whether it is safe to restore.
- `/g-restore-backup` — restore the primary store from backup only when the primary store is unreadable and backup is readable.
- `/g-config` — show operational config: version, store/backup/lock path, max retry backoff, event window, and remote deploy helper.
- `/g-run` — run the current goal immediately, bypassing any future retry delay.
- `/g-resume` — resume a paused or draft goal.
- `/g-pause` — pause automatic continuation.
- `/g-stop` — stop automatic continuation.
- `/g-done` or `/g-complete` — mark the goal complete.
- `/g-mode finish|forever` — switch between finish-oriented and forever-running modes.

Compatibility aliases also exist under `/goal-*`, for example `/goal-stop`, `/goal-add`, and `/goal-config`.

## Behavior

Current config exposed by `/g-config` and `GET /api/goals/status`: version `1.4.0`, max retry backoff `20m` (`1200000` ms), default mode `finish`, store lock timeout `10s` (`10000` ms), stale lock recovery `60s` (`60000` ms), watchdog interval `30s` (`30000` ms), event window `40`, backup path `~/.pi/agent/goal-runner.json.bak`.

1. Starting a goal begins in `draft/clarifying` and asks a short dynamic set of clarification questions.
2. The user's next normal message is transformed into an execution-start prompt and the goal enters `running/executing`.
3. `agent_settled` schedules the next continuation while the goal remains running.
4. Successful turns clear failure count and schedule a short continuation delay.
5. Failed, aborted, or interrupted turns retry with exponential backoff, capped at 20 minutes.
6. The goal never marks itself complete; only the user can complete it.
7. Pi-web restart recovery scans `goal-runner.json` and resumes running goals, respecting `nextRetryAt` to avoid duplicate continuations.
8. Pi-web also runs a 30-second watchdog that restores overdue running goals even if an extension timer was lost after startup.
9. Test runs and explicit `PI_WEB_DISABLE_AUTO_RESUME=1` disable startup auto-resume and the watchdog so automated tests cannot touch real persisted Goals.
10. Every successful write refreshes `goal-runner.json.bak`; reads fall back to that backup with a `recover` event if the primary store is unreadable.

## Pi-web integration

APIs:

- `GET /api/goals/status?sessionId=<id>` returns availability, config, current goal, active goals, diagnostics, runtime status, watchdog status, lock status, backup status, events, and subgoals.
- `GET /api/goals/status?sessionId=<id>&eventTypes=restore,run` filters the returned recent `events` list while leaving `eventSummary` as the full compacted recent-history summary; `config.storePath` plus `config.lockPath`/`backupPath`/`watchdogIntervalMs`/`maxEvents` make the operational configuration self-contained, and `eventSummary` includes `total`, `rawTotal`, `returnedTotal`, `compacted`, `filtered`, `filterTypes`, `maxEvents`, `oldestAt`, and pre-sorted `topTypes` with each type's latest timestamp/message. `returnedTotal` is the number of `events` returned in the current response after any `eventTypes` filter; `total` remains the compacted summary-window size.
- `watchdog.startedAt` identifies a watchdog that has started but has not completed its first scan yet; `watchdog.nextScanAt` estimates the next periodic scan; `watchdog.nextScanOverdueMs` is normally `0` and becomes positive if the timer appears late; `watchdog.lastScanDurationMs` reports how long the previous scan took; `watchdog.active` means a scan is currently in progress, while an enabled idle watchdog is healthy between scans.
- `POST /api/goals/action` supports `pause`, `resume`, `run-now`, `stop`, `complete`, `mode`, `add`, `subtask`, `unlock-stale-lock`, and protected `restore-backup` actions.

UI:

- The Agents panel shows a Goal Runner system card.
- The card shows status, health, live runtime state, retry timing, watchdog state, lock/backup state, version/config, recent events, subgoals, and active-goal count.
- The card exposes event filter chips: `all`, `restore`, `settled`, `run`, `retry`, `error`, and `subtask`; chips show event-type counts, `all` shows summary/returned counts such as `all 13/8` when the recent list is capped, and hover titles explain empty filters.
- The card can pause, resume, stop, mark done, toggle finish/forever, append subgoals, and mark subgoals done/reopen.

## Deployment

Local install after editing the extension:

```bash
cd /home/wap1wep/pi-web-agegr
mkdir -p ~/.pi/agent/extensions/pi-goal-runner
cp extensions/pi-goal-runner/index.ts ~/.pi/agent/extensions/pi-goal-runner/index.ts
systemctl --user restart pi-web-agegr.service
```

Remote deployment to `100.64.0.2`:

```bash
cd /home/wap1wep/pi-web-agegr
scripts/deploy-remote-100-64-0-2.sh
```

The remote script first performs a local SSH reachability preflight. If `100.64.0.2` is unreachable, it exits with status 70 before deployment starts, prints `deployment did not start`, and reports the current local commit plus retry commands. When reachable, it uses a deployment lock, Node 22, a bounded build timeout, and diagnostic output on failure. For extension-only syncs where the Next.js bundle did not change, use:

```bash
SKIP_BUILD=1 scripts/deploy-remote-100-64-0-2.sh
```

## Verification

Recommended checks:

```bash
npm test -- --runInBand lib/goal-runner.test.mjs lib/pi-goal-runner-extension.test.mjs
npm run build
```

Then verify a new Pi-web runtime command table contains 48 Goal commands:

- `g`
- `goal`
- `g-start`
- `g-add`
- `g-status`
- `g-list`
- `g-subtasks`
- `g-subtask-done`
- `g-subtask-open`
- `g-subtask-block`
- `g-events`
- `g-config`
- `g-doctor`
- `g-lock`
- `g-unlock`
- `g-backup`
- `g-restore-backup`
- `g-help`
- `g-run`
- `g-resume`
- `g-pause`
- `g-stop`
- `g-done`
- `g-complete`
- `g-mode`
- `goal-start`
- `goal-add`
- `goal-status`
- `goal-list`
- `goal-subtasks`
- `goal-subtask-done`
- `goal-subtask-open`
- `goal-subtask-block`
- `goal-events`
- `goal-config`
- `goal-doctor`
- `goal-lock`
- `goal-unlock`
- `goal-backup`
- `goal-restore-backup`
- `goal-help`
- `goal-run`
- `goal-resume`
- `goal-pause`
- `goal-stop`
- `goal-complete`
- `goal-done`
- `goal-mode`

And verify the status API returns `config.version`, `config.maxRetryMs`, `config.maxEvents`, `config.lockTimeoutMs`, `config.lockStaleMs`, `config.watchdogIntervalMs`, `lock`, `backup`, `watchdog`, `current.runtime`, and `current.diagnostics` for a running goal.

Note: terminal commands run inside the Pi extension and can inspect the persistent store, lock, and backup files. Pi-web-only live runtime fields such as `current.runtime.liveRunning`, completion-notification suppression, and watchdog scan counters are exposed through the Pi-web API/UI, not through `/g-config`.

## Troubleshooting

- Start with `/g-doctor` for a one-shot terminal diagnostic summary of version, store path, backup, lock, current goal, retry timing, event summary top types, and recent events.
- Use `/g-events restore run` or the API `eventTypes=restore,run` filter when the full event history is noisy.
- If the Goal appears stuck waiting for a future retry, use `/g-run` or the Pi-web **Run now** button to bypass the retry delay; Pi-web skips duplicate delivery when the session is already live-running.
- If the store lock is suspicious, inspect with `/g-lock`; only use `/g-unlock` when it reports a stale lock. Non-stale locks are never removed by the command.
- If `goal-runner.json` is unreadable, inspect `/g-backup`; it reports whether the backup contains the current session, and `/g-restore-backup` only restores when the primary store is unreadable and the backup is readable.
- For Pi-web-specific runtime state such as live-running sessions, watchdog `nextScanAt`/`lastScanDurationMs`, and skipped-running recovery counts, check `GET /api/goals/status?sessionId=<id>` or the Agents panel because terminal commands cannot see live RPC session state.
- If the Agents panel shows watchdog `overdue` in orange, `watchdog.nextScanOverdueMs` is positive and the periodic watchdog timer appears late; check service logs and restart Pi-web if the value keeps increasing.

## Remote recovery note

If `100.64.0.2` is unreachable over SSH and HTTP, do not assume deployment completed. Re-run the remote deployment script when the host is reachable, then verify HTTP 8504 and the Goal command table.
