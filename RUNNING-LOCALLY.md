# Running AuditForge unattended on Windows

Long verification runs need three things to stay alive: the PC, the Node server, and the
browser tab. The verification queue (`src/lib/verify-queue.ts`) runs in that tab; the
server only answers its `/api/*` calls.

```
npm run bg:start              # build, start hidden server on :3000, open an unthrottled browser
npm run bg:start -- -SkipBuild  # reuse the last build (only if no code changed since)
npm run bg:stop               # stop server, release the sleep block
```

Logs go to `.logs/server-*.log`.

## What `bg:start` does

| Problem | Fix |
|---|---|
| `npm run dev` dies when VS Code or the terminal closes | Runs `next start` (production build) as a hidden process, separate from the terminal |
| The PC idle-sleeps mid-run | `scripts/keep-awake.ps1` holds a Windows `ES_SYSTEM_REQUIRED` power request while the server runs. The display can still turn off and the screen saver / lock screen still works |
| A screen saver or lock screen makes Chrome treat the tab as hidden, then drop the wake lock and throttle timers to about one per minute | Opens a dedicated Chrome/Edge profile with `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, and native occlusion detection turned off |

**Run audits from the window that `bg:start` opens.** Your normal Chrome window does not
have these flags. The dedicated profile is stored at `%LOCALAPPDATA%\AuditForge\browser-profile`.
Connect GSC once in that window; the connection persists there.

## What nothing can work around

- **Manual sleep** (Start → Sleep, power button). In S3 sleep the CPU and
  network stop. When the PC wakes, the queue detects the gap and re-queues in-flight batches
  (they are not marked UNVERIFIABLE), so it resumes. It just doesn't progress while asleep.
- **Windows Update restarts.** Set *Settings → Windows Update → Active hours* to cover the run,
  or pause updates for the night.
- **Power loss.** Progress is checkpointed every 40 pages in the browser profile's
  localStorage, so you can resume.

## Recommended Windows settings (one-time)

These are optional, because `bg:start` already blocks idle sleep, but they cover runs started with plain `npm run dev`:

```powershell
powercfg /change standby-timeout-ac 0     # never sleep on AC (this machine already has this set)
powercfg /change monitor-timeout-ac 10    # turning the screen off is fine
```

The screen saver and the "require sign-in on wake" setting are both fine with `bg:start`.
