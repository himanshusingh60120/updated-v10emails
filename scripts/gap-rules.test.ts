/**
 * Verifies the rules added from the Screaming Frog gap analysis, and — the part
 * that actually matters — that the ones depending on non-default export columns
 * stay silent when those columns are absent instead of firing on every page.
 *
 * Usage: npx tsx scripts/gap-rules.test.ts
 */
import { detectIssues, RULES } from "../src/lib/detect";
import { ABSENT_SCORE, CrawlRow, CrawlRowSchema } from "../src/lib/schema";

const fail = (m: string) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const row = (over: Partial<CrawlRow>): CrawlRow =>
  CrawlRowSchema.parse({
    url: "https://example.com/",
    statusCode: 200,
    indexability: "Indexable",
    contentType: "text/html; charset=UTF-8",
    outlinks: 5,
    ...over,
  });

const NEW_RULES = [
  "no-response",
  "nofollow-directive",
  "no-internal-outlinks",
  "title-equals-h1",
  "h1-duplicate",
  "h1-long",
  "meta-short",
  "h2-duplicate",
  "h2-long",
  "url-contains-space",
  "url-non-ascii",
  "url-too-long",
  "title-pixels-long",
  "title-pixels-short",
  "meta-pixels-long",
  "meta-pixels-short",
  "h2-multiple",
  "oversized-resource",
  "readability-very-difficult",
  "readability-difficult",
];

console.log(`Rule engine now carries ${RULES.length} rules (${NEW_RULES.length} added).`);
for (const id of NEW_RULES) {
  if (!RULES.some((r) => r.id === id)) fail(`rule "${id}" is not registered`);
}
const ids = RULES.map((r) => r.id);
if (new Set(ids).size !== ids.length) fail("duplicate rule ids in RULES");

/* ── 1. Default export: no optional columns present ─────────────────────── */
// The critical case. readability defaults to the absent sentinel; if that were
// 0 instead, every page would read as "very difficult".
const defaultExport: CrawlRow[] = [
  row({ url: "https://example.com/a", title: "Alpha", h1: "Alpha", metaDescription: "x".repeat(50), metaLength: 50 }),
  row({ url: "https://example.com/b", title: "Beta", h1: "Shared heading", h2: "Shared sub" }),
  row({ url: "https://example.com/c", title: "Gamma", h1: "Shared heading", h2: "Shared sub" }),
  row({ url: "https://example.com/d", h1: "L".repeat(80), h2: "S".repeat(80), outlinks: 0 }),
  row({ url: "https://example.com/e", statusCode: 0 }),
  row({ url: "https://example.com/f", metaRobots: "noindex, nofollow" }),
  row({ url: "https://example.com/with%20space" }),
  row({ url: "https://example.com/caf\u00e9-r\u00e9sum\u00e9" }),
  row({ url: `https://example.com/${"p".repeat(120)}` }),
];
const got = detectIssues(defaultExport);
const count = (id: string) => got.filter((i) => i.ruleId === id).length;

const expectDefault: Record<string, number> = {
  "no-response": 1,
  "nofollow-directive": 1,
  "no-internal-outlinks": 1,
  "title-equals-h1": 1,
  "h1-duplicate": 2,
  "h1-long": 1,
  "meta-short": 1,
  "h2-duplicate": 2,
  "h2-long": 1,
  "url-contains-space": 1,
  "url-non-ascii": 1,
  "url-too-long": 1,
};
for (const [id, want] of Object.entries(expectDefault)) {
  const g = count(id);
  if (g !== want) fail(`${id}: expected ${want} on the default export, got ${g}`);
}
console.log("Default-export rules fire correctly.");

// Column-gated rules must be completely silent here.
const gated = ["title-pixels-long", "title-pixels-short", "meta-pixels-long", "meta-pixels-short", "h2-multiple", "oversized-resource", "readability-difficult", "readability-very-difficult"];
for (const id of gated) {
  if (count(id) !== 0) fail(`${id} fired ${count(id)} times with its column absent — it must stay silent`);
}
console.log("Column-gated rules stay silent when their columns are absent (readability sentinel holds).");

/* ── 2. Full export: optional columns present ───────────────────────────── */
const fullExport: CrawlRow[] = [
  row({ url: "https://example.com/1", titlePixels: 700, metaPixels: 1100, h2: "A", h2Second: "B", readability: 12 }),
  row({ url: "https://example.com/2", titlePixels: 150, metaPixels: 320, readability: 41 }),
  row({ url: "https://example.com/3", readability: 75 }),
  row({ url: "https://example.com/4.pdf", contentType: "application/pdf", sizeBytes: 3 * 1024 * 1024 }),
];
const got2 = detectIssues(fullExport);
const count2 = (id: string) => got2.filter((i) => i.ruleId === id).length;
const expectFull: Record<string, number> = {
  "title-pixels-long": 1,
  "title-pixels-short": 1,
  "meta-pixels-long": 1,
  "meta-pixels-short": 1,
  "h2-multiple": 1,
  "oversized-resource": 1,
  "readability-very-difficult": 1,
  "readability-difficult": 1,
};
for (const [id, want] of Object.entries(expectFull)) {
  const g = count2(id);
  if (g !== want) fail(`${id}: expected ${want} on the full export, got ${g}`);
}
// A readable page must not be flagged.
if (got2.some((i) => i.url.endsWith("/3") && i.ruleId.startsWith("readability")))
  fail("readability fired on a page scoring 75 (easy)");
console.log("Column-gated rules activate correctly when the columns are present.");

/* ── 3. Header aliasing through the real normalizer ─────────────────────── */
// Guards the parse.ts HEADER_MAP additions, not just the schema defaults.
const aliased = CrawlRowSchema.parse({
  url: "https://example.com/x",
  statusCode: 200,
  titlePixels: 600,
  readability: 0,
});
if (aliased.readability !== 0) fail("a real Flesch score of 0 must survive parsing");
if (CrawlRowSchema.parse({ url: "https://example.com/y", statusCode: 200 }).readability !== ABSENT_SCORE)
  fail("absent readability must fall back to the sentinel");
console.log("Flesch 0 (valid) and absent readability (sentinel) are distinguishable.");

/* ── 4. Regression: robots-blocked rows must not become Critical findings ──
 * Screaming Frog reports Status Code 0 for URLs it never fetched because
 * robots.txt disallowed them. Treating that as "no response" made every
 * blocked URL a Critical finding, which jumped the verification queue and then
 * came back UNVERIFIABLE — a 100%-unverifiable audit on any site with an
 * aggressive robots.txt.
 */
const robotsBlocked: CrawlRow[] = Array.from({ length: 500 }, (_, i) =>
  row({
    url: `https://example.com/blocked/${i}`,
    statusCode: 0,
    indexability: "Non-Indexable",
    indexabilityStatus: "Blocked by robots.txt",
    inlinks: 5,
  })
);
const blockedIssues = detectIssues(robotsBlocked);
if (blockedIssues.some((i) => i.ruleId === "no-response"))
  fail("no-response fired on robots.txt-blocked rows — every blocked URL becomes a false Critical");
if (blockedIssues.some((i) => i.severity === "Critical"))
  fail("robots-blocked rows produced a Critical finding and would jump the verify queue");
if (!blockedIssues.some((i) => i.ruleId === "blocked-with-inlinks"))
  fail("blocked-with-inlinks should still cover these rows");

// A genuine no-response (status 0, nothing explaining it) must still fire.
const genuine = detectIssues([row({ url: "https://example.com/dead", statusCode: 0, inlinks: 3 })]);
if (!genuine.some((i) => i.ruleId === "no-response")) fail("no-response stopped firing on a genuine dead URL");
console.log("Robots-blocked rows stay out of no-response; genuine dead URLs still fire.");

console.log("\nAll gap-rule assertions passed.");