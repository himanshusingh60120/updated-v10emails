/**
 * npx tsx scripts/queue-resilience.test.ts
 *
 * The scenario this guards against: a laptop sleeps mid-audit. Every in-flight
 * request aborts at once. The old code stamped each of those URLs UNVERIFIABLE
 * and moved on, quietly poisoning the report with a fact about the laptop
 * rather than the website.
 */

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

import { CpuBudget, DEFAULT_BUDGET } from "../src/lib/cpu-budget";
import { VerifyQueue } from "../src/lib/verify-queue";
import { Issue } from "../src/lib/schema";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

function makeIssues(count: number): Issue[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `issue-${i}`,
    ruleId: "http-4xx",
    ruleLabel: "4xx",
    severity: "Critical" as const,
    owner: "Dev" as const,
    url: `https://example.com/page-${i}`,
    evidence: "404 in crawl",
    verification: "PENDING" as const,
    impactScore: 0,
    fixStatus: "Open" as const,
  }));
}

/** Stubs fetch: the first `failures` calls reject the way a suspend does. */
function stubFetch(failures: number) {
  let calls = 0;
  let rejected = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    if (rejected < failures) {
      rejected++;
      // Exactly what an aborted-on-suspend fetch throws in a browser.
      throw new TypeError("Failed to fetch");
    }
    const body = JSON.parse(String(init.body)) as { pages: { checks: { issueId: string }[] }[] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.pages.flatMap((p) =>
          p.checks.map((c) => ({ issueId: c.issueId, status: "CONFIRMED", liveEvidence: "HTTP 404" }))
        ),
        meter: { instanceId: "test", instanceCpuMs: calls * 5, requestCpuMs: 5, wallMs: 20 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
  return () => ({ calls, rejected });
}

(async () => {
  console.log("suspend mid-run");
  {
    store.clear();
    const issues = makeIssues(24); // 3 batches of 8
    const stats = stubFetch(3); // every in-flight batch dies, as on wake
    const queue = new VerifyQueue({
      issues,
      auditId: "suspend-test",
      budget: new CpuBudget({ ...DEFAULT_BUDGET }, true),
      concurrency: 3,
    });

    const result = await queue.run();
    const unverifiable = result.issues.filter((i) => i.verification === "UNVERIFIABLE");
    const confirmed = result.issues.filter((i) => i.verification === "CONFIRMED");

    assert(unverifiable.length === 0, "a transport failure produces no UNVERIFIABLE verdicts");
    assert(confirmed.length === 24, "all 24 issues are verified after the retries land");
    assert(result.complete, "the run still reports complete");
    assert(stats().rejected === 3, "the failures really did happen (3 aborted batches)");
  }

  console.log("\npersistent failure still terminates");
  {
    store.clear();
    const issues = makeIssues(8);
    stubFetch(Number.MAX_SAFE_INTEGER); // network never comes back
    const queue = new VerifyQueue({
      issues,
      auditId: "dead-network-test",
      budget: new CpuBudget({ ...DEFAULT_BUDGET }, true),
      concurrency: 1,
    });

    const result = await queue.run();
    const unverifiable = result.issues.filter((i) => i.verification === "UNVERIFIABLE");
    assert(unverifiable.length === 8, "after the retry budget is spent, issues are marked UNVERIFIABLE");
    assert(
      unverifiable.every((i) => (i.verifyError ?? "").includes("retries")),
      "the error says the retries were exhausted, not just 'failed to fetch'"
    );
  }

  console.log("\nHTTP errors are not retried as transport failures");
  {
    store.clear();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid request: bad url" }),
      }) as unknown as Response) as typeof fetch;

    const queue = new VerifyQueue({
      issues: makeIssues(8),
      auditId: "http-error-test",
      budget: new CpuBudget({ ...DEFAULT_BUDGET }, true),
      concurrency: 1,
    });
    const started = Date.now();
    const result = await queue.run();
    assert(
      result.issues.every((i) => i.verification === "UNVERIFIABLE"),
      "a real 400 from the server is recorded immediately"
    );
    assert(Date.now() - started < 3000, "a 400 does not sit through the transport backoff ladder");
  }

  console.log("\nall queue resilience assertions pass");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
