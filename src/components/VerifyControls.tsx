"use client";
import { useEffect, useState } from "react";
import { BudgetConfig, BudgetSnapshot, fmtCpu, HOBBY_ACTIVE_CPU_MS } from "@/lib/cpu-budget";
import { useWakeLock } from "@/lib/use-wake-lock";
import { QueueStatus } from "@/lib/verify-queue";

interface Props {
  status: QueueStatus;
  budget: BudgetSnapshot | null;
  config: BudgetConfig;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onConfigChange: (config: BudgetConfig) => void;
  onResetLedger: () => void;
}

const barColor: Record<BudgetSnapshot["level"], string> = {
  ok: "bg-verdant",
  warn: "bg-forge",
  pause: "bg-ember",
  exhausted: "bg-ember",
};

const stateLabel: Record<QueueStatus["state"], string> = {
  idle: "Ready",
  running: "Verifying",
  paused: "Paused",
  cooldown: "Cooling down",
  offline: "Waiting for network",
  halted: "Stopped",
  done: "Finished",
};

const stateGlyph: Record<QueueStatus["state"], string> = {
  idle: "▢",
  running: "▶",
  paused: "❚❚",
  cooldown: "◷",
  offline: "⚠",
  halted: "■",
  done: "▣",
};

function useCountdown(until?: number): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!until) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, until - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [until]);
  return remaining;
}

export default function VerifyControls({
  status,
  budget,
  config,
  onPause,
  onResume,
  onStop,
  onConfigChange,
  onResetLedger,
}: Props) {
  const [showSettings, setShowSettings] = useState(false);
  const countdown = useCountdown(status.cooldownUntil);
  const running = status.state === "running";
  const holdable = status.state === "paused" || status.state === "halted" || status.state === "cooldown";
  const local = budget?.unlimited ?? false;

  // Keep the screen — and therefore this tab's timers — alive while working.
  const wakeLock = useWakeLock(running || status.state === "cooldown" || status.state === "offline");

  const stateTone =
    status.state === "running"
      ? "text-forge"
      : status.state === "cooldown"
        ? "text-cobalt"
        : status.state === "offline"
          ? "text-ember"
          : "text-steel";

  return (
    <div className="no-print rounded-lg border border-edge bg-panel/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`font-mono text-[11px] uppercase tracking-widest ${stateTone}`}>
            {stateGlyph[status.state]} {stateLabel[status.state]}
          </span>
          <span className="font-mono text-xs text-steel">
            {status.done.toLocaleString()} / {status.total.toLocaleString()} URLs
          </span>
          {status.retrying > 0 && (
            <span className="font-mono text-xs text-cobalt">{status.retrying} batch(es) queued for retry</span>
          )}
          {local && (
            <span className="chip border border-verdant/40 text-verdant" title="Served from this machine — no Vercel billing">
              local · unmetered
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {running && (
            <button className="btn" onClick={onPause}>
              ❚❚ Pause
            </button>
          )}
          {holdable && (
            <button className="btn border-forge/60 text-forge" onClick={onResume}>
              ▶ Resume
            </button>
          )}
          {(running || holdable || status.state === "offline") && status.state !== "halted" && (
            <button className="btn" onClick={onStop} title="Keep everything verified so far and go to the report">
              ■ Stop and report
            </button>
          )}
          {!local && (
            <button className="btn" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
              ⚙ CPU budget
            </button>
          )}
        </div>
      </div>

      {status.state === "cooldown" && countdown > 0 && (
        <p className="mt-3 font-mono text-xs text-cobalt">
          Resuming in {Math.ceil(countdown / 1000)}s — no CPU is billed while cooling down.
        </p>
      )}
      {status.message && status.state !== "cooldown" && <p className="mt-3 text-sm text-steel">{status.message}</p>}

      {status.wokeFromSuspend && (
        <p className="mt-3 text-xs text-cobalt">
          This machine slept during the run. Interrupted batches were put back in the queue rather than marked
          unverifiable, so nothing was lost.
        </p>
      )}

      {(running || status.state === "cooldown") && wakeLock.supported && !wakeLock.held && (
        <p className="mt-3 text-xs text-steel">
          Screen wake lock not held — the browser only grants it to a visible tab. Keep this tab in front, and stop the
          machine sleeping at the OS level for unattended runs.
        </p>
      )}

      {local ? (
        <p className="mt-4 text-xs text-steel">
          Running locally: verification uses this machine&apos;s CPU, so there is no allowance to protect and no
          cooldown. This run has used{" "}
          <span className="font-mono text-slate-200">{fmtCpu(budget?.runUsedMs ?? 0)}</span> of CPU — useful as an
          estimate of what the same audit would cost deployed.
        </p>
      ) : (
        budget && (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px] text-steel">
              <span>
                Active CPU this month:{" "}
                <span className={budget.level === "ok" ? "text-slate-200" : "text-forge"}>{fmtCpu(budget.usedMs)}</span>{" "}
                of {fmtCpu(budget.spendableMs)} spendable
              </span>
              <span>
                This audit: {fmtCpu(budget.runUsedMs)} of {fmtCpu(budget.runBudgetMs)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-ink">
              <div
                className={`h-full transition-all ${barColor[budget.level]}`}
                style={{ width: `${Math.min(100, Math.round(budget.usedPct * 100))}%` }}
              />
            </div>
            {budget.level === "warn" && (
              <p className="mt-2 text-xs text-forge">
                Past {Math.round(config.warnPct * 100)}% of the monthly allowance — running at half concurrency to
                stretch what is left.
              </p>
            )}
            {budget.level === "pause" && (
              <p className="mt-2 text-xs text-ember">
                Almost out of Active CPU for {budget.month}. Verification is down to one request at a time.
              </p>
            )}
          </div>
        )
      )}

      {showSettings && !local && (
        <div className="mt-4 space-y-3 rounded border border-edge bg-ink/60 p-3">
          <p className="text-xs text-steel">
            Vercel Hobby includes {fmtCpu(HOBBY_ACTIVE_CPU_MS)} of Active CPU per calendar month. These numbers are
            measured from the server&apos;s own <code className="font-mono text-forge/80">process.cpuUsage()</code>, not
            estimated, so they should track the Vercel dashboard closely.
          </p>

          <label className="block text-xs text-steel">
            Monthly allowance (CPU minutes)
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-slate-200"
              value={Math.round(config.monthlyBudgetMs / 60000)}
              onChange={(e) =>
                onConfigChange({ ...config, monthlyBudgetMs: Math.max(1, Number(e.target.value)) * 60000 })
              }
            />
          </label>

          <label className="block text-xs text-steel">
            Ceiling for one audit (CPU minutes) — stops a single upload eating the month
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-slate-200"
              value={Math.round(config.perRunBudgetMs / 60000)}
              onChange={(e) =>
                onConfigChange({ ...config, perRunBudgetMs: Math.max(1, Number(e.target.value)) * 60000 })
              }
            />
          </label>

          <label className="block text-xs text-steel">
            Pace (CPU seconds per minute) — exceed it and the queue cools down, then resumes on its own
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-slate-200"
              value={Math.round(config.burstBudgetMs / 1000)}
              onChange={(e) => onConfigChange({ ...config, burstBudgetMs: Math.max(1, Number(e.target.value)) * 1000 })}
            />
          </label>

          <label className="block text-xs text-steel">
            Cooldown length (seconds)
            <input
              type="number"
              min={5}
              className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-slate-200"
              value={Math.round(config.cooldownMs / 1000)}
              onChange={(e) => onConfigChange({ ...config, cooldownMs: Math.max(5, Number(e.target.value)) * 1000 })}
            />
          </label>

          <button className="btn" onClick={onResetLedger}>
            Reset the measured total
          </button>
          <p className="text-[11px] text-steel">
            Reset after Vercel&apos;s monthly rollover, or if you clear usage on another machine. The ledger lives in
            this browser and counts only what this browser spent.
          </p>
        </div>
      )}
    </div>
  );
}
