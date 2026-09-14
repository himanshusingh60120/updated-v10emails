/**
 * npx tsx scripts/budget.test.ts
 *
 * Covers the parts of the CPU governor that are easy to get subtly wrong:
 * concurrent readings from one instance must not double-count, restarted
 * instances must not lose their banked total, and the thresholds must fire in
 * the right order.
 */

// Minimal localStorage shim so the client module runs under tsx.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

import { CpuBudget, DEFAULT_BUDGET, fmtCpu } from "../src/lib/cpu-budget";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("cpu ledger");
{
  store.clear();
  const budget = new CpuBudget({ ...DEFAULT_BUDGET });

  // Three overlapping requests served by one instance. The instance reports a
  // cumulative counter, so the ledger must land on 900 — not 100+400+900.
  budget.record({ instanceId: "a", instanceCpuMs: 100 });
  budget.record({ instanceId: "a", instanceCpuMs: 400 });
  budget.record({ instanceId: "a", instanceCpuMs: 900 });
  assert(budget.usedMs() === 900, "cumulative readings from one instance are not double-counted");

  // A second instance spins up alongside it.
  budget.record({ instanceId: "b", instanceCpuMs: 250 });
  assert(budget.usedMs() === 1150, "a second instance adds to the total");

  // Instance "a" is recycled and a fresh process reuses nothing: cumulative
  // drops. The 900 already spent must stay banked.
  budget.record({ instanceId: "a", instanceCpuMs: 10 });
  assert(budget.usedMs() === 1160, "a restarted instance banks its prior total instead of losing it");
}

console.log("thresholds");
{
  store.clear();
  const config = { ...DEFAULT_BUDGET, monthlyBudgetMs: 100_000, reservePct: 0, perRunBudgetMs: 1_000_000 };
  const budget = new CpuBudget(config);

  assert(budget.snapshot().level === "ok", "fresh ledger is ok");
  assert(budget.concurrency(3) === 3, "full concurrency while ok");

  budget.record({ instanceId: "x", instanceCpuMs: 72_000 }); // 72%
  assert(budget.snapshot().level === "warn", "crossing warnPct flips to warn");
  assert(budget.concurrency(3) === 1, "warn halves concurrency (3 -> 1)");
  assert(budget.check().action !== "halt", "warn does not halt");

  budget.record({ instanceId: "x", instanceCpuMs: 95_000 }); // 95%
  assert(budget.snapshot().level === "pause", "crossing pausePct flips to pause");

  budget.record({ instanceId: "x", instanceCpuMs: 101_000 }); // over
  assert(budget.snapshot().level === "exhausted", "past the spendable ceiling is exhausted");
  const verdict = budget.check();
  assert(verdict.action === "halt", "exhausted budget halts the queue");
  assert(verdict.action === "halt" && verdict.reason.includes("resets"), "halt explains when the allowance returns");
}

console.log("per-run ceiling and burst cooldown");
{
  store.clear();
  const budget = new CpuBudget({
    ...DEFAULT_BUDGET,
    monthlyBudgetMs: 10_000_000,
    perRunBudgetMs: 5_000,
    burstBudgetMs: 2_000,
  });

  budget.record({ instanceId: "y", instanceCpuMs: 2_500 });
  const cooldown = budget.check();
  assert(cooldown.action === "cooldown", "exceeding the per-minute pace triggers a cooldown, not a halt");
  assert(cooldown.action === "cooldown" && cooldown.ms > 0, "cooldown carries a duration so the queue can resume itself");

  budget.record({ instanceId: "y", instanceCpuMs: 6_000 });
  assert(budget.check().action === "halt", "passing the per-run ceiling halts");

  budget.resetRun();
  assert(budget.snapshot().runUsedMs === 0, "resetRun clears run spend but keeps the monthly ledger");
  assert(budget.usedMs() === 6_000, "monthly total survives a run reset");
}

console.log("reconcile with the Vercel dashboard");
{
  store.clear();
  const budget = new CpuBudget({ ...DEFAULT_BUDGET });
  budget.record({ instanceId: "z", instanceCpuMs: 5_000 });
  budget.reconcile(3 * 60 * 60 * 1000); // dashboard says 3 CPU-hours
  assert(budget.usedMs() === 10_800_000, "reconcile overrides the measured total");
  // 3h against a 3.6h spendable ceiling is 83% — warn territory, not spent.
  assert(budget.snapshot().level === "warn", "3h of a 4h allowance (10% reserved) reads as warn");

  budget.reconcile(3.5 * 60 * 60 * 1000);
  assert(budget.snapshot().level === "pause", "3.5h of the same allowance crosses into pause");
}

console.log("formatting");
{
  assert(fmtCpu(820) === "820ms", "sub-second reads in ms");
  assert(fmtCpu(4_500) === "4.5s", "seconds get one decimal");
  assert(fmtCpu(270_000) === "4m 30s", "minutes and seconds");
  assert(fmtCpu(4 * 3600 * 1000) === "4h 0m", "the Hobby allowance reads as 4h 0m");
}

console.log("\nall budget assertions pass");
