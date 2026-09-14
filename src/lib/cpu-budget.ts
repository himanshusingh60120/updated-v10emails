"use client";

/**
 * Active CPU budget ledger + governor.
 *
 * Vercel Hobby includes 4 Active CPU hours per calendar month (plus 360 GB-hr
 * of Provisioned Memory and 1M invocations — neither is the binding constraint
 * for this workload). Blowing through 4 CPU-hours pauses the whole account, so
 * the app meters itself and refuses to spend past a ceiling it controls.
 *
 * Two independent guards:
 *
 *   1. Monthly ceiling — a hard stop, persisted across sessions and page loads.
 *   2. Burst governor  — a token bucket that stops any single run from eating
 *      the month in one sitting. When the bucket empties, the queue cools down
 *      and resumes automatically once it refills.
 *
 * Everything is measured, never estimated: the numbers come from
 * `process.cpuUsage()` on the server (see lib/cpu-meter.ts).
 *
 * **Local runs are unlimited.** When the app is served from localhost, the CPU
 * belongs to you, not to Vercel, so enforcement switches off entirely. The
 * meter keeps running — it is useful for sizing what a deployed run would cost
 * — but it never pauses, throttles or halts anything.
 */

export const HOBBY_ACTIVE_CPU_MS = 4 * 60 * 60 * 1000; // 14,400,000 ms = 4 CPU-hours

/**
 * True when the app is being served from this machine. Kept deliberately
 * conservative: anything that is not obviously local is treated as billed.
 */
export function isLocalRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    // Private LAN ranges — running the dev server for someone else on the network.
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export interface BudgetConfig {
  /** Total Active CPU ms available per calendar month. */
  monthlyBudgetMs: number;
  /** Fraction held back so the rest of the app keeps working after a big audit. */
  reservePct: number;
  /** Usage fraction that triggers a warning in the UI. */
  warnPct: number;
  /** Usage fraction that auto-pauses the queue and asks before continuing. */
  pausePct: number;
  /** Ceiling for one audit run. Stops a single upload from eating the month. */
  perRunBudgetMs: number;
  /** Token bucket: CPU ms allowed inside a rolling window. */
  burstBudgetMs: number;
  burstWindowMs: number;
  /** How long to cool down when the bucket empties. */
  cooldownMs: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  monthlyBudgetMs: HOBBY_ACTIVE_CPU_MS,
  reservePct: 0.1, //  keep 24 CPU-min in reserve
  warnPct: 0.7,
  pausePct: 0.9,
  perRunBudgetMs: 20 * 60 * 1000, // 20 CPU-minutes per audit
  burstBudgetMs: 60 * 1000, // 60 CPU-seconds…
  burstWindowMs: 60 * 1000, // …per rolling minute
  cooldownMs: 45 * 1000,
};

const LEDGER_KEY = "auditforge:cpu-ledger";
const CONFIG_KEY = "auditforge:cpu-budget-config";
/** Instances idle this long are folded into the carried total and forgotten. */
const INSTANCE_TTL_MS = 30 * 60 * 1000;

interface InstanceRecord {
  /** Highest cumulative Active CPU we have seen this instance report. */
  ms: number;
  /** Epoch ms of the last reading, used for compaction. */
  seen: number;
}

interface Ledger {
  /** Billing month, UTC — Vercel resets allowances on the calendar month. */
  month: string;
  /** CPU from instances that have aged out, already folded in. */
  carriedMs: number;
  instances: Record<string, InstanceRecord>;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyLedger(): Ledger {
  return { month: currentMonth(), carriedMs: 0, instances: {} };
}

function loadLedger(): Ledger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as Ledger;
    // Month rollover: Vercel's allowance resets, so ours does too.
    if (parsed.month !== currentMonth()) return emptyLedger();
    return parsed;
  } catch {
    return emptyLedger();
  }
}

function saveLedger(ledger: Ledger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* storage full or blocked — the in-memory ledger still governs this session */
  }
}

export function loadBudgetConfig(): BudgetConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_BUDGET;
    return { ...DEFAULT_BUDGET, ...(JSON.parse(raw) as Partial<BudgetConfig>) };
  } catch {
    return DEFAULT_BUDGET;
  }
}

export function saveBudgetConfig(config: BudgetConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* best effort */
  }
}

export interface BudgetSnapshot {
  month: string;
  usedMs: number;
  budgetMs: number;
  /** Budget minus the reserve — the number the guards actually compare against. */
  spendableMs: number;
  remainingMs: number;
  usedPct: number;
  runUsedMs: number;
  runBudgetMs: number;
  level: "ok" | "warn" | "pause" | "exhausted";
  /** True on a local run: metered for information, never enforced. */
  unlimited: boolean;
}

export type GovernorVerdict =
  | { action: "go" }
  | { action: "cooldown"; ms: number; reason: string }
  | { action: "halt"; reason: string };

/**
 * Tracks measured Active CPU and decides whether the verification queue may
 * dispatch its next batch. One instance per audit run.
 */
export class CpuBudget {
  private ledger: Ledger;
  private config: BudgetConfig;
  private unlimited: boolean;
  /** CPU spent by the current run only. */
  private runMs = 0;
  /** Rolling window of [timestamp, cpuMs] pairs for the token bucket. */
  private burst: [number, number][] = [];
  /** Baseline per instance at run start, so runMs counts only this run's spend. */
  private runBaseline = new Map<string, number>();
  private listeners = new Set<(s: BudgetSnapshot) => void>();

  constructor(config: BudgetConfig = loadBudgetConfig(), unlimited: boolean = isLocalRuntime()) {
    this.config = config;
    this.unlimited = unlimited;
    this.ledger = loadLedger();
    this.compact();
  }

  /** Fold aged-out instances into `carriedMs` so the map cannot grow forever. */
  private compact(): void {
    const cutoff = Date.now() - INSTANCE_TTL_MS;
    for (const [id, rec] of Object.entries(this.ledger.instances)) {
      if (rec.seen < cutoff) {
        this.ledger.carriedMs += rec.ms;
        delete this.ledger.instances[id];
      }
    }
  }

  isUnlimited(): boolean {
    return this.unlimited;
  }

  /**
   * Record a server reading. Cumulative-per-instance means repeated readings
   * from the same instance replace rather than add — no double counting when
   * requests run concurrently.
   */
  record(reading: { instanceId: string; instanceCpuMs: number }): void {
    const { instanceId, instanceCpuMs } = reading;
    if (!instanceId || !Number.isFinite(instanceCpuMs)) return;

    const previous = this.ledger.instances[instanceId]?.ms ?? 0;
    // A restarted instance can report a lower cumulative than we last saw.
    // Treat that as a fresh instance: bank what we had and start over.
    if (instanceCpuMs < previous) {
      this.ledger.carriedMs += previous;
      this.runBaseline.set(instanceId, 0);
      this.ledger.instances[instanceId] = { ms: instanceCpuMs, seen: Date.now() };
      this.runMs += instanceCpuMs;
      this.pushBurst(instanceCpuMs);
      saveLedger(this.ledger);
      this.emit();
      return;
    }

    const delta = instanceCpuMs - previous;
    this.ledger.instances[instanceId] = { ms: instanceCpuMs, seen: Date.now() };

    // First sighting during this run: don't charge the run for CPU the instance
    // burned before we started using it.
    if (!this.runBaseline.has(instanceId)) {
      this.runBaseline.set(instanceId, previous);
    }
    if (delta > 0) {
      this.runMs += delta;
      this.pushBurst(delta);
    }
    saveLedger(this.ledger);
    this.emit();
  }

  private pushBurst(ms: number): void {
    this.burst.push([Date.now(), ms]);
    this.trimBurst();
  }

  private trimBurst(): void {
    const cutoff = Date.now() - this.config.burstWindowMs;
    while (this.burst.length > 0 && this.burst[0][0] < cutoff) this.burst.shift();
  }

  private burstUsedMs(): number {
    this.trimBurst();
    return this.burst.reduce((sum, [, ms]) => sum + ms, 0);
  }

  usedMs(): number {
    return (
      this.ledger.carriedMs +
      Object.values(this.ledger.instances).reduce((sum, r) => sum + r.ms, 0)
    );
  }

  snapshot(): BudgetSnapshot {
    const used = this.usedMs();
    const spendable = this.config.monthlyBudgetMs * (1 - this.config.reservePct);
    const pct = spendable === 0 ? 1 : used / spendable;
    const level: BudgetSnapshot["level"] = this.unlimited
      ? "ok"
      : pct >= 1
        ? "exhausted"
        : pct >= this.config.pausePct
          ? "pause"
          : pct >= this.config.warnPct
            ? "warn"
            : "ok";
    return {
      month: this.ledger.month,
      usedMs: used,
      budgetMs: this.config.monthlyBudgetMs,
      spendableMs: spendable,
      remainingMs: Math.max(0, spendable - used),
      usedPct: pct,
      runUsedMs: this.runMs,
      runBudgetMs: this.config.perRunBudgetMs,
      level,
      unlimited: this.unlimited,
    };
  }

  /** Called before every batch dispatch. */
  check(): GovernorVerdict {
    // Local runs burn your CPU, not a metered allowance. Never throttle them.
    if (this.unlimited) return { action: "go" };

    const snap = this.snapshot();

    if (snap.level === "exhausted") {
      return {
        action: "halt",
        reason:
          `Monthly Active CPU budget spent: ${fmtCpu(snap.usedMs)} of ${fmtCpu(snap.spendableMs)} ` +
          `(${fmtCpu(snap.budgetMs)} allowance minus a ${Math.round(this.config.reservePct * 100)}% reserve). ` +
          `The allowance resets on the 1st. Everything verified so far is in the report — ` +
          `raise the ceiling in CPU settings to continue anyway.`,
      };
    }

    if (this.runMs >= this.config.perRunBudgetMs) {
      return {
        action: "halt",
        reason:
          `This audit hit its per-run ceiling of ${fmtCpu(this.config.perRunBudgetMs)} Active CPU. ` +
          `${fmtCpu(snap.remainingMs)} is still available this month — raise the per-run ceiling to keep going.`,
      };
    }

    const burstUsed = this.burstUsedMs();
    if (burstUsed >= this.config.burstBudgetMs) {
      return {
        action: "cooldown",
        ms: this.config.cooldownMs,
        reason:
          `Spending ${fmtCpu(burstUsed)} of CPU per minute — above the ${fmtCpu(this.config.burstBudgetMs)} pace ` +
          `that keeps this audit inside the monthly allowance. Cooling down, then resuming automatically.`,
      };
    }

    return { action: "go" };
  }

  /** How many batches to run in parallel right now. Drops as the budget tightens. */
  concurrency(max: number): number {
    if (this.unlimited) return max;
    const level = this.snapshot().level;
    if (level === "pause" || level === "exhausted") return 1;
    if (level === "warn") return Math.max(1, Math.floor(max / 2));
    return max;
  }

  resetRun(): void {
    this.runMs = 0;
    this.burst = [];
    this.runBaseline.clear();
    this.emit();
  }

  setConfig(config: BudgetConfig): void {
    this.config = config;
    saveBudgetConfig(config);
    this.emit();
  }

  getConfig(): BudgetConfig {
    return this.config;
  }

  /** Clears the measured ledger. For when Vercel's dashboard is the source of truth. */
  resetLedger(): void {
    this.ledger = emptyLedger();
    saveLedger(this.ledger);
    this.resetRun();
  }

  /** Seeds the ledger from Vercel's dashboard number, so the two agree. */
  reconcile(usedMs: number): void {
    this.ledger = { month: currentMonth(), carriedMs: Math.max(0, usedMs), instances: {} };
    saveLedger(this.ledger);
    this.emit();
  }

  subscribe(fn: (s: BudgetSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

/** Formats Active CPU ms the way the Vercel dashboard reads: 1h 12m, 4m 30s, 820ms. */
export function fmtCpu(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
