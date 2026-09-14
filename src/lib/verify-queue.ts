"use client";
import { CpuBudget, isLocalRuntime } from "@/lib/cpu-budget";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint, VerifyCheckpoint } from "@/lib/checkpoint";
import {
  HeaderFinding,
  Issue,
  severityRank,
  VerifyMeter,
  VerifyPageRequest,
  VerifyResultItem,
} from "@/lib/schema";

/**
 * The verification driver.
 *
 * Design points that matter:
 *
 *   1. **One request per URL, not per issue.** The old loop mapped issues 1:1
 *      onto fetches, so a page flagged for a missing title, missing meta,
 *      missing H1 and thin content was fetched and fully parsed four times.
 *
 *   2. **Pause, cooldown and resume are first-class.** Workers pass through a
 *      gate before every dispatch, so pausing takes effect within one batch and
 *      never leaves a request half-finished.
 *
 *   3. **Suspend-safe.** A laptop that sleeps mid-run aborts every in-flight
 *      request at once. Those batches go back on a retry queue; they are never
 *      recorded as UNVERIFIABLE, because "your Wi-Fi went away" is not evidence
 *      about anyone's website. See `dispatch()`.
 *
 *   4. **Priority order.** Critical and High issues are verified first, so a run
 *      that is paused, cooled down or halted at 40% still produces the report
 *      that matters.
 */

export const MAX_PAGES_PER_REQUEST = 8;
/** Parallel batches against a *billed* deployment. */
export const MAX_CONCURRENCY = 3;
/** Local runs aren't metered, so the only limit is politeness to the target site. */
export const LOCAL_CONCURRENCY = 5;
/** Client-side politeness pacing. Sleeping here is free; sleeping in a function is billed. */
export const CLIENT_DELAY_MS = 250;
const CHECKPOINT_EVERY_PAGES = 40;
/** Transport failures retried before a batch is finally called UNVERIFIABLE. */
const MAX_TRANSPORT_RETRIES = 4;
/**
 * A gap larger than this between watchdog ticks means the machine was
 * suspended — timers do not fire while a laptop is asleep.
 */
const SUSPEND_GAP_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5_000;

export type QueueState = "idle" | "running" | "paused" | "cooldown" | "offline" | "halted" | "done";

export interface QueueStatus {
  state: QueueState;
  done: number;
  total: number;
  /** Epoch ms when an automatic cooldown ends. */
  cooldownUntil?: number;
  /** Batches waiting to be retried after a transport failure. */
  retrying: number;
  /** True if the machine appears to have slept during this run. */
  wokeFromSuspend: boolean;
  /** Why the queue paused, cooled down or halted — always human-readable. */
  message?: string;
}

export interface VerifyRunResult {
  issues: Issue[];
  headerFindings: HeaderFinding[];
  linksBySource: Map<string, string[]>;
  /** False when the run was stopped, halted by the budget, or capped. */
  complete: boolean;
  verifiedPages: number;
  skippedIssues: number;
  cpuMs: number;
}

export interface VerifyQueueOptions {
  issues: Issue[];
  auditId: string;
  budget: CpuBudget;
  /** Harvest same-origin links for the link-jump pass. Forces a full DOM parse. */
  collectLinks?: boolean;
  /** Hard cap on URLs verified this run. Issues beyond it are marked SKIPPED. */
  maxUrls?: number;
  /** Parallel batches. Defaults to 5 locally, 3 against a billed deployment. */
  concurrency?: number;
  /**
   * Fired once the queue is built, before any request goes out. Reports what
   * will *actually* be attempted after the URL cap is applied — which is not
   * the same as the number of pending issues, and is what any ETA must be
   * based on.
   */
  onReady?: (info: { urls: number; checks: number; skippedIssues: number }) => void;
  /** Called with each batch of results — batched, so React re-renders stay sane. */
  onResults?: (results: VerifyResultItem[], issuesById: Map<string, Issue>) => void;
  onStatus?: (status: QueueStatus) => void;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A latch the workers wait on. Pausing flips it closed; resuming releases everyone. */
class Gate {
  private open = true;
  private waiters: (() => void)[] = [];

  close(): void {
    this.open = false;
  }

  release(): void {
    this.open = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  async pass(): Promise<void> {
    if (this.open) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

/** A fetch that never reached the server: DNS, socket, abort, offline. */
function isTransportFailure(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch's rejection type for network errors
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "NetworkError")) return true;
  return e instanceof Error && /failed to fetch|network|load failed|connection|ECONN|socket/i.test(e.message);
}

export class VerifyQueue {
  private opts: VerifyQueueOptions;
  private gate = new Gate();
  private state: QueueState = "idle";
  private message = "";
  private cooldownUntil = 0;
  private stopped = false;
  private cursor = 0;
  private completedPages = 0;
  private inFlight = 0;
  private pages: VerifyPageRequest[] = [];
  /** Batches bounced back by a transport failure, retried before new work. */
  private retryQueue: { batch: VerifyPageRequest[]; attempt: number }[] = [];
  private results = new Map<string, VerifyResultItem>();
  private headerFindings: HeaderFinding[] = [];
  private linksBySource = new Map<string, string[]>();
  private issuesById = new Map<string, Issue>();
  private pending: VerifyResultItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pagesSinceCheckpoint = 0;
  private startCpuMs = 0;
  private concurrency: number;
  private wokeFromSuspend = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private detachNetwork: (() => void) | null = null;

  constructor(opts: VerifyQueueOptions) {
    this.opts = opts;
    this.issuesById = new Map(opts.issues.map((i) => [i.id, i]));
    this.concurrency = opts.concurrency ?? (isLocalRuntime() ? LOCAL_CONCURRENCY : MAX_CONCURRENCY);
  }

  /* ---------------------------------------------------------------- controls */

  pause(reason = "Paused. Nothing is running and no CPU is being spent."): void {
    if (this.state !== "running" && this.state !== "cooldown") return;
    this.gate.close();
    this.setState("paused", reason);
    void this.checkpoint();
  }

  resume(): void {
    if (this.state === "running" || this.state === "done") return;
    this.cooldownUntil = 0;
    this.setState("running", "");
    this.gate.release();
  }

  stop(): void {
    this.stopped = true;
    this.setState("halted", "Stopped. Everything verified so far is kept.");
    this.gate.release();
  }

  getStatus(): QueueStatus {
    return {
      state: this.state,
      done: this.completedPages,
      total: this.pages.length,
      cooldownUntil: this.cooldownUntil || undefined,
      retrying: this.retryQueue.length,
      wokeFromSuspend: this.wokeFromSuspend,
      message: this.message || undefined,
    };
  }

  private setState(state: QueueState, message: string): void {
    this.state = state;
    this.message = message;
    this.opts.onStatus?.(this.getStatus());
  }

  /* ------------------------------------------------- suspend / offline guards */

  /**
   * Two things stall a long local run: the machine sleeping, and the network
   * dropping. Both look identical to `fetch` — it just rejects — so we watch
   * for them explicitly and hold the queue instead of burning through the
   * remaining URLs marking them all unverifiable.
   */
  private attachNetworkGuards(): void {
    if (typeof window === "undefined") return;

    const goOffline = () => {
      if (this.stopped || this.state === "offline") return;
      this.gate.close();
      this.setState("offline", "Network unavailable. Holding the queue — it resumes by itself once you're back online.");
      void this.checkpoint();
    };
    const goOnline = () => {
      if (this.stopped || this.state !== "offline") return;
      this.setState("running", "");
      this.gate.release();
    };

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    // Timers do not fire while a machine is suspended, so an unexplained gap
    // between ticks is the clearest signal that we just woke up.
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastTick;
      this.lastTick = now;
      if (gap > SUSPEND_GAP_MS) {
        this.wokeFromSuspend = true;
        if (typeof navigator !== "undefined" && navigator.onLine === false) goOffline();
        else this.opts.onStatus?.(this.getStatus());
      }
    }, WATCHDOG_INTERVAL_MS);

    this.detachNetwork = () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
    };

    if (typeof navigator !== "undefined" && navigator.onLine === false) goOffline();
  }

  /** Blocks until the browser reports a connection again. */
  private async waitForOnline(): Promise<void> {
    // `onLine` is undefined outside a browser; only an explicit `false` means
    // offline. Anything else is treated as connected, so this can never hang.
    const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;
    while (!this.stopped && offline()) await sleep(2000);
  }

  /* ------------------------------------------------------------------- build */

  /**
   * Collapse issues into one task per URL, highest-severity URLs first.
   * A URL is worth verifying once; the rules riding on it are all re-checked
   * from that single fetch.
   */
  private buildQueue(): { pages: VerifyPageRequest[]; skipped: Issue[] } {
    const pending = this.opts.issues.filter((i) => i.verification === "PENDING");
    const byUrl = new Map<string, Issue[]>();
    for (const issue of pending) {
      const bucket = byUrl.get(issue.url);
      if (bucket) bucket.push(issue);
      else byUrl.set(issue.url, [issue]);
    }

    const ranked = [...byUrl.entries()]
      .map(([url, issues]) => ({
        url,
        issues,
        rank: Math.min(...issues.map((i) => severityRank(i.severity))),
        impact: Math.max(...issues.map((i) => i.impactScore ?? 0)),
      }))
      .sort((a, b) => a.rank - b.rank || b.impact - a.impact);

    const cap = this.opts.maxUrls ?? Infinity;
    const kept = ranked.slice(0, cap);
    const skipped = ranked.slice(cap).flatMap((entry) => entry.issues);

    const pages: VerifyPageRequest[] = kept.map((entry) => ({
      url: entry.url,
      checks: entry.issues.map((i) => ({
        issueId: i.id,
        ruleId: i.ruleId,
        crawlEvidence: i.evidence,
      })),
    }));

    return { pages, skipped };
  }

  /* ------------------------------------------------------------- checkpoints */

  private async checkpoint(): Promise<void> {
    const cp: VerifyCheckpoint = {
      auditId: this.opts.auditId,
      updatedAt: Date.now(),
      label: `${this.completedPages}/${this.pages.length} URLs verified`,
      queue: this.pages,
      cursor: this.cursor,
      results: Object.fromEntries(this.results),
      linksBySource: Object.fromEntries(this.linksBySource),
      runCpuMs: this.opts.budget.snapshot().runUsedMs,
    };
    await saveCheckpoint(cp);
  }

  /** Restores a paused or interrupted run. Call before run(). */
  async restore(): Promise<boolean> {
    const cp = await loadCheckpoint(this.opts.auditId);
    if (!cp || cp.queue.length === 0) return false;
    this.pages = cp.queue;
    this.cursor = cp.cursor;
    this.completedPages = cp.cursor;
    this.results = new Map(Object.entries(cp.results));
    this.linksBySource = new Map(Object.entries(cp.linksBySource));
    return true;
  }

  /* -------------------------------------------------------------- UI batching */

  /**
   * The old loop called setLive() once per result — thousands of React updates
   * for a large audit, which is why the tab crawled. Results are queued and
   * flushed on a timer instead.
   */
  private queueResults(items: VerifyResultItem[]): void {
    this.pending.push(...items);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushResults();
    }, 200);
  }

  private flushResults(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.opts.onResults?.(batch, this.issuesById);
  }

  /* --------------------------------------------------------------------- run */

  /** Retries first, then new work. Null means there is nothing to hand out. */
  private takeBatch(): { batch: VerifyPageRequest[]; attempt: number } | null {
    const retry = this.retryQueue.shift();
    if (retry) return retry;
    if (this.cursor >= this.pages.length) return null;
    const start = this.cursor;
    this.cursor = Math.min(this.pages.length, start + MAX_PAGES_PER_REQUEST);
    return { batch: this.pages.slice(start, this.cursor), attempt: 0 };
  }

  private hasWorkLeft(): boolean {
    return this.cursor < this.pages.length || this.retryQueue.length > 0 || this.inFlight > 0;
  }

  async run(): Promise<VerifyRunResult> {
    const built = this.buildQueue();
    // A restored queue wins: it already reflects what was done before the pause.
    if (this.pages.length === 0) this.pages = built.pages;

    this.startCpuMs = this.opts.budget.snapshot().runUsedMs;
    this.opts.onReady?.({
      urls: this.pages.length,
      checks: this.pages.reduce((sum, p) => sum + p.checks.length, 0),
      skippedIssues: built.skipped.length,
    });
    this.setState("running", "");
    this.opts.onProgress?.(this.completedPages, this.pages.length);

    if (this.pages.length === 0) {
      this.setState("done", "");
      return this.finish(built.skipped, true);
    }

    this.attachNetworkGuards();

    const worker = async (slot: number) => {
      while (!this.stopped && this.hasWorkLeft()) {
        // Hold back extra workers when the budget says to slow down.
        while (!this.stopped && slot >= this.opts.budget.concurrency(this.concurrency)) {
          await sleep(1000);
        }
        if (this.stopped) return;

        await this.gate.pass();
        if (this.stopped) return;

        const verdict = this.opts.budget.check();
        if (verdict.action === "halt") {
          this.gate.close();
          this.setState("halted", verdict.reason);
          await this.checkpoint();
          await this.gate.pass(); // released by resume() if the user overrides
          if (this.stopped) return;
          continue;
        }
        if (verdict.action === "cooldown") {
          // Only one worker announces and serves the cooldown; the rest queue
          // up behind the gate and wake together.
          if (this.state !== "cooldown") {
            this.gate.close();
            this.cooldownUntil = Date.now() + verdict.ms;
            this.setState("cooldown", verdict.reason);
            await sleep(verdict.ms);
            if (this.stopped) return;
            this.cooldownUntil = 0;
            this.setState("running", "");
            this.gate.release();
          } else {
            await this.gate.pass();
          }
          continue;
        }

        const work = this.takeBatch();
        if (!work) {
          // Nothing to take, but a sibling may still bounce a batch back.
          if (this.inFlight > 0) {
            await sleep(250);
            continue;
          }
          return;
        }

        this.inFlight++;
        try {
          await this.dispatch(work.batch, work.attempt);
        } finally {
          this.inFlight--;
        }

        this.opts.onProgress?.(this.completedPages, this.pages.length);
        // Progress is a status change too: without this the controls' own
        // counter stays frozen at whatever the last setState() emitted.
        this.opts.onStatus?.(this.getStatus());
        if (this.pagesSinceCheckpoint >= CHECKPOINT_EVERY_PAGES) {
          this.pagesSinceCheckpoint = 0;
          void this.checkpoint();
        }

        // Politeness pacing, on the client where it costs nothing.
        if (CLIENT_DELAY_MS > 0) await sleep(CLIENT_DELAY_MS);
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, (_, i) => worker(i)));

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushResults();
    this.detachNetwork?.();

    const complete = !this.stopped && !this.hasWorkLeft() && this.state !== "halted";
    if (complete) {
      this.setState("done", "");
      await clearCheckpoint(this.opts.auditId);
    } else {
      await this.checkpoint();
    }
    return this.finish(built.skipped, complete);
  }

  private async dispatch(batch: VerifyPageRequest[], attempt: number): Promise<void> {
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pages: batch,
          delayMs: 0,
          collectLinks: this.opts.collectLinks ?? false,
          collectHeaders: true,
        }),
      });

      if (res.status === 429) {
        await sleep(5000);
        this.retryQueue.push({ batch, attempt }); // 429 is not a failed attempt
        return;
      }

      const data = (await res.json()) as {
        results?: VerifyResultItem[];
        meter?: VerifyMeter;
        error?: string;
      };

      // Charge the budget before anything else, even on a partial response —
      // the CPU was spent whether or not we liked the answer.
      if (data.meter) this.opts.budget.record(data.meter);

      if (!res.ok || !data.results) throw new Error(data.error ?? `Verify batch failed (${res.status})`);

      for (const r of data.results) {
        this.results.set(r.issueId, r);
        if (r.headerFindings) this.headerFindings.push(...r.headerFindings);
      }
      // internalLinks ride on the first check of each page; map them back by URL.
      for (const page of batch) {
        const firstId = page.checks[0]?.issueId;
        const links = firstId ? this.results.get(firstId)?.internalLinks : undefined;
        if (links && links.length > 0) this.linksBySource.set(page.url, links);
      }
      this.queueResults(data.results);
      this.completedPages += batch.length;
      this.pagesSinceCheckpoint += batch.length;
    } catch (e) {
      // A machine waking from sleep aborts every open request at once. That is
      // a fact about this laptop, not about the customer's website, so the
      // batch goes back on the queue rather than into the report.
      if (isTransportFailure(e) && attempt < MAX_TRANSPORT_RETRIES && !this.stopped) {
        await this.waitForOnline();
        await sleep(Math.min(15_000, 1000 * 2 ** attempt)); // 1s, 2s, 4s, 8s
        this.retryQueue.push({ batch, attempt: attempt + 1 });
        this.opts.onStatus?.(this.getStatus());
        return;
      }

      const message = e instanceof Error ? e.message : "Batch request failed";
      const failures: VerifyResultItem[] = batch.flatMap((page) =>
        page.checks.map((c) => ({
          issueId: c.issueId,
          status: "UNVERIFIABLE" as const,
          liveEvidence: "",
          verifyError:
            attempt >= MAX_TRANSPORT_RETRIES
              ? `${message} (after ${MAX_TRANSPORT_RETRIES} retries)`
              : message,
        }))
      );
      for (const f of failures) this.results.set(f.issueId, f);
      this.queueResults(failures);
      this.completedPages += batch.length;
      this.pagesSinceCheckpoint += batch.length;
    }
  }

  private finish(skipped: Issue[], complete: boolean): VerifyRunResult {
    const now = new Date().toISOString();
    const skippedIds = new Set(skipped.map((i) => i.id));

    const issues = this.opts.issues.map((issue) => {
      const result = this.results.get(issue.id);
      if (result) {
        return {
          ...issue,
          verification: result.status,
          liveEvidence: result.liveEvidence || issue.liveEvidence,
          verifyError: result.verifyError,
          verifiedAt: now,
        };
      }
      if (skippedIds.has(issue.id)) {
        return {
          ...issue,
          verification: "SKIPPED" as const,
          verifyError: `Beyond this run's URL cap — re-run verification to include it.`,
        };
      }
      if (issue.verification === "PENDING" && !complete) {
        return {
          ...issue,
          verification: "SKIPPED" as const,
          verifyError: "Run stopped before this URL was reached — resume to verify it.",
        };
      }
      return issue;
    });

    return {
      issues,
      headerFindings: this.headerFindings,
      linksBySource: this.linksBySource,
      complete,
      verifiedPages: this.completedPages,
      skippedIssues: skipped.length,
      cpuMs: this.opts.budget.snapshot().runUsedMs - this.startCpuMs,
    };
  }
}