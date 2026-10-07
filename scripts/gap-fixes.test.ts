/**
 * Regression tests for the gap fixes.
 *
 * Each block below pins a behaviour that was previously wrong in a way the type
 * system could not catch — the kind of bug that produces a confident, plausible,
 * incorrect report rather than a crash.
 */
import { canonicalizeUrl, UrlIndex } from "../src/lib/url-utils";
import { attachCrawlInlinkSources, groupFixesByTemplate, tracedUrl } from "../src/lib/sources";
import { auditSitemap } from "../src/lib/sitemap-rules";
import { runPreflight } from "../src/lib/preflight";
import { analyzeUrlHygiene, buildRedirectMap, redirectMapAsHtaccess, redirectMapAsNextConfig, redirectMapAsNginx } from "../src/lib/modules";
import { detectIssues } from "../src/lib/detect";
import { computeDelta, computeImpactScores } from "../src/lib/analysis";
import { changedLiveStatusFinding, createFullSiteUrlChecks, summarizeFullSiteChecks } from "../src/lib/full-site-check";
import type { CrawlRow, InlinkEdge, Issue, SitemapFetchResult } from "../src/lib/schema";

let failures = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok — ${label}`);
  } else {
    failures++;
    console.log(`  FAIL — ${label}${detail ? ` (${detail})` : ""}`);
  }
}

const row = (url: string, over: Partial<CrawlRow> = {}): CrawlRow => ({
  url,
  statusCode: 200,
  indexability: "Indexable",
  indexabilityStatus: "",
  title: "t",
  titleLength: 1,
  metaDescription: "m",
  metaLength: 1,
  h1: "h",
  h1Second: "",
  h2: "h2",
  canonical: url,
  metaRobots: "index, follow",
  wordCount: 500,
  crawlDepth: 1,
  inlinks: 5,
  outlinks: 5,
  responseTime: 0.2,
  contentType: "text/html",
  redirectUrl: "",
  redirectType: "",
  titlePixels: 0,
  metaPixels: 0,
  h2Second: "",
  sizeBytes: 0,
  readability: -999,
  ...over,
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "http-4xx::https://example.com/dead",
  ruleId: "http-4xx",
  ruleLabel: "4xx client error",
  severity: "Critical",
  owner: "Dev",
  url: "https://example.com/dead",
  evidence: "HTTP 404",
  verification: "CONFIRMED",
  impactScore: 10,
  fixStatus: "Open",
  ...over,
});

const edge = (over: Partial<InlinkEdge> & Pick<InlinkEdge, "source" | "target">): InlinkEdge => ({
  anchor: "",
  linkType: "Hyperlink",
  linkPosition: "Content",
  ...over,
});

/* -------------------------------------------------------------------------- */
console.log("\nURL normalization");
/* -------------------------------------------------------------------------- */

ok(
  "trailing slash, www and protocol all fold to one key",
  canonicalizeUrl("http://www.example.com/page/") === canonicalizeUrl("https://example.com/page")
);
ok("fragments never distinguish two URLs", canonicalizeUrl("https://example.com/a#top") === canonicalizeUrl("https://example.com/a"));
ok("an empty query string is not a difference", canonicalizeUrl("https://example.com/a?") === canonicalizeUrl("https://example.com/a"));
ok(
  "query parameter order does not matter",
  canonicalizeUrl("https://example.com/a?b=2&a=1") === canonicalizeUrl("https://example.com/a?a=1&b=2")
);
ok(
  "path case is NOT folded by default (sites do serve /Foo and /foo separately)",
  canonicalizeUrl("https://example.com/Foo") !== canonicalizeUrl("https://example.com/foo")
);
ok("an unparseable address still groups with itself", canonicalizeUrl("not a url") === canonicalizeUrl("not a url"));

const idx = new UrlIndex<string>();
idx.set("https://example.com/Page/", "hit");
ok("exact match is reported as exact", idx.lookup("https://example.com/Page/").match === "exact");
ok("slash-only difference resolves canonically", idx.lookup("https://example.com/Page").match === "canonical");
ok("case-only difference resolves as fuzzy, not silently as exact", idx.lookup("https://example.com/page").match === "fuzzy");
ok("a genuine miss is reported as a miss", idx.lookup("https://example.com/other").match === "miss");

/* -------------------------------------------------------------------------- */
console.log("\nError-source tracing");
/* -------------------------------------------------------------------------- */

const dead = "https://example.com/dead";
const edges: InlinkEdge[] = [
  edge({ source: "https://example.com/a", target: `${dead}/`, anchor: "Dead link", linkPosition: "Footer", linkPath: "/html/body/footer/a" }),
  edge({ source: "https://example.com/b", target: dead, anchor: "Dead link", linkPosition: "Footer" }),
  edge({ source: "https://example.com/c", target: dead, altText: "Broken image", linkType: "Image", linkPosition: "Content" }),
  edge({ source: "https://example.com/d", target: "https://example.com/alive" }),
];

const traced = attachCrawlInlinkSources([issue()], edges);
const t0 = traced.issues[0];
ok("all three edges are counted, including the one differing by a trailing slash", t0.sourceInlinkCount === 3, String(t0.sourceInlinkCount));
ok("an Image edge survives parsing — hyperlink-only filtering was the root cause", (t0.sourceByType ?? {}).Image === 1);
ok("sources are grouped by page position", (t0.sourceByPosition ?? {}).Footer === 2 && (t0.sourceByPosition ?? {}).Content === 1);
ok("the XPath from the export reaches the issue", (t0.sourceSamples ?? []).some((s) => s.linkPath === "/html/body/footer/a"));
ok("the trace is marked as having succeeded", t0.sourceTrace === "traced");

const untraced = attachCrawlInlinkSources([issue({ url: "https://example.com/nobody-links-here" })], edges);
ok(
  "a URL nothing links to is reported as not-linked, not left blank",
  untraced.issues[0].sourceTrace === "not-linked-internally"
);
const noGraph = attachCrawlInlinkSources([issue()], null);
ok(
  "no link graph uploaded is a different state from nothing linking here",
  noGraph.issues[0].sourceTrace === "no-link-graph"
);

// The bug: live-broken-link is filed on the LINKING page, so tracing `url`
// attached "pages that link to the linking page" under a heading claiming to
// show where the broken URL came from.
const liveBroken = issue({
  id: "live-broken-link::a -> dead",
  ruleId: "live-broken-link",
  url: "https://example.com/a",
  targetUrl: dead,
});
ok("tracing follows targetUrl, not the page the finding is filed against", tracedUrl(liveBroken) === dead);
const liveTraced = attachCrawlInlinkSources([liveBroken], edges);
ok(
  "a live-broken-link finding gets the broken URL's sources, not the linking page's",
  liveTraced.issues[0].sourceInlinkCount === 3
);

const groups = groupFixesByTemplate(traced.issues);
ok("template grouping surfaces the footer as the highest-leverage fix", groups[0]?.position === "Footer");
ok("the footer group counts one distinct broken target, not two tickets", groups[0]?.brokenTargets === 1);

/* -------------------------------------------------------------------------- */
console.log("\nSitemap rules");
/* -------------------------------------------------------------------------- */

const sitemap: SitemapFetchResult = {
  entries: [
    { loc: "https://example.com/good", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://example.com/dead", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://example.com/moved", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://example.com/hidden", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://example.com/aliased", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://other-site.com/page", foundIn: "https://example.com/sitemap.xml" },
    { loc: "https://example.com/never-crawled", foundIn: "https://example.com/sitemap.xml" },
  ],
  files: [
    {
      url: "https://example.com/sitemap.xml",
      status: 200,
      contentType: "application/xml",
      gzipped: false,
      bytes: 900,
      kind: "urlset",
      urlCount: 7,
      depth: 0,
      discoveredVia: "robots.txt",
    },
    {
      url: "https://example.com/sitemap-broken.xml",
      status: 404,
      contentType: "text/html",
      gzipped: false,
      bytes: 0,
      kind: "unreadable",
      urlCount: 0,
      depth: 0,
      error: "HTTP 404",
      discoveredVia: "robots.txt",
    },
  ],
  robotsDeclared: ["https://example.com/sitemap.xml", "https://example.com/sitemap-broken.xml"],
  robotsStatus: 200,
  robotsFetched: true,
  truncated: false,
  warnings: [],
};

const rows: CrawlRow[] = [
  row("https://example.com/good"),
  row("https://example.com/dead", { statusCode: 404 }),
  row("https://example.com/moved", { statusCode: 301, redirectUrl: "https://example.com/good" }),
  row("https://example.com/hidden", { metaRobots: "noindex, follow", indexabilityStatus: "noindex" }),
  row("https://example.com/aliased", { canonical: "https://example.com/good" }),
];

const audit = auditSitemap({ sitemap, rows, gsc: [] });
const ids = audit.issues.map((i) => i.ruleId);
ok("a 404 in the sitemap is reported as broken", ids.includes("sitemap-url-broken"));
ok("a redirecting sitemap URL is flagged", ids.includes("sitemap-url-redirects"));
ok("a noindex sitemap URL is flagged", ids.includes("sitemap-url-noindex"));
ok("a non-self-canonical sitemap URL is flagged", ids.includes("sitemap-url-non-canonical"));
ok("a cross-domain entry is flagged", ids.includes("sitemap-url-cross-domain"));
ok("a sitemap robots.txt promises but cannot serve is flagged", ids.includes("sitemap-declared-but-broken"));
ok(
  "a URL absent from the crawl is NOT called an orphan without checking it",
  !audit.issues.some((i) => i.ruleId === "sitemap-url-orphan" && i.url.includes("never-crawled"))
);
ok(
  "it is instead handed back for live verification",
  audit.summary.unknownToCrawl.includes("https://example.com/never-crawled")
);
ok("sitemap findings are real Issues with severity and owner", audit.issues.every((i) => Boolean(i.severity && i.owner)));

/* -------------------------------------------------------------------------- */
console.log("\nPreflight");
/* -------------------------------------------------------------------------- */

const pfMissing = runPreflight({
  rows,
  columns: ["Address", "Status Code"],
  fieldsPresent: ["url", "statusCode"],
  issues: [],
  gsc: [],
  sitemapEntries: [],
  inlinkEdges: 0,
  hasIssuesOverview: false,
});
const meta = pfMissing.ruleCoverage.find((c) => c.label === "Meta descriptions");
ok("a missing column marks its rules not-checked rather than passed", meta?.readiness === "not-checked");
ok("the absent column is named", (meta?.missing ?? []).includes("metaDescription"));
ok("optional pixel and readability rules are explicitly not measured when columns are absent", ["Pixel widths", "Readability scores"].every((label) => pfMissing.ruleCoverage.find((c) => c.label === label)?.readiness === "not-checked"));
ok("an empty link graph is surfaced as a signal", pfMissing.signals.some((s) => s.id === "no-link-graph"));
ok("confidence drops when most checks could not run", pfMissing.confidence < 50, String(pfMissing.confidence));

const allOk: (keyof CrawlRow)[] = [
  "url", "statusCode", "redirectUrl", "title", "titleLength", "metaDescription", "metaLength",
  "h1", "h1Second", "h2", "h2Second", "canonical", "metaRobots", "indexability", "inlinks", "outlinks", "crawlDepth",
  "wordCount", "responseTime", "titlePixels", "metaPixels", "sizeBytes", "readability", "contentType",
];
const pfFull = runPreflight({
  rows,
  columns: allOk,
  fieldsPresent: allOk,
  issues: [],
  gsc: [],
  sitemapEntries: [],
  inlinkEdges: 1200,
  hasIssuesOverview: true,
});
ok("a complete export scores higher than a partial one", pfFull.confidence > pfMissing.confidence);

// The filtered-export tell: a large crawl with nothing but 200s.
const allTwoHundred = Array.from({ length: 1200 }, (_, n) => row(`https://example.com/p${n}`));
const pfFiltered = runPreflight({
  rows: allTwoHundred,
  columns: allOk,
  fieldsPresent: allOk,
  issues: [],
  gsc: [],
  sitemapEntries: [],
  inlinkEdges: 10,
  hasIssuesOverview: true,
});
ok("a 1,200-URL crawl with zero non-200s is called out as probably filtered", pfFiltered.signals.some((s) => s.id === "all-200"));

const pfSmallCrawl = runPreflight({
  rows,
  columns: allOk,
  fieldsPresent: allOk,
  issues: [],
  gsc: [],
  sitemapEntries: Array.from({ length: 400 }, (_, n) => ({
    loc: `https://example.com/s${n}`,
    foundIn: "https://example.com/sitemap.xml",
  })),
  inlinkEdges: 10,
  hasIssuesOverview: true,
});
ok(
  "a crawl far smaller than the sitemap is called out",
  pfSmallCrawl.signals.some((s) => s.id === "crawl-much-smaller-than-sitemap")
);

/* -------------------------------------------------------------------------- */
console.log("\nDetection and export regressions");
/* -------------------------------------------------------------------------- */

const redirects = detectIssues([
  row("https://example.com/foo", { statusCode: 301, redirectUrl: "https://example.com/foo/" }),
  row("https://example.com/foo/"),
  row("https://example.com/Bar", { statusCode: 301, redirectUrl: "https://example.com/bar" }),
  row("https://example.com/bar"),
  row("https://example.com/a", { statusCode: 301, redirectUrl: "https://example.com/b" }),
  row("https://example.com/b", { statusCode: 301, redirectUrl: "https://example.com/a" }),
]);
ok("slash and case redirects are not called loops", !redirects.some((i) => i.ruleId === "redirect-loop" && /foo|Bar|bar/.test(i.url)));
ok("an actual two-URL redirect cycle is still detected", redirects.some((i) => i.ruleId === "redirect-loop" && i.url.endsWith("/a")));

const clientErrors = detectIssues([401, 403, 404, 410, 429].map((statusCode) =>
  row(`https://example.com/error-${statusCode}`, { statusCode })
));
ok("401, 403 and 429 are not Critical findings", clientErrors.filter((i) => i.ruleId === "http-4xx" && [401, 403, 429].some((s) => i.url.endsWith(String(s)))).every((i) => i.severity === "Medium"));
ok("410 is High while a 404 remains Critical", clientErrors.find((i) => i.url.endsWith("410"))?.severity === "High" && clientErrors.find((i) => i.url.endsWith("404"))?.severity === "Critical");

const hygieneRows = [
  ...Array.from({ length: 40 }, (_, n) => row(`https://example.com/product-${n}?sort=price`)),
  ...Array.from({ length: 60 }, (_, n) => row(`https://example.com/2025/03/post-${n}`)),
];
const hygiene = analyzeUrlHygiene(hygieneRows);
ok("parameter bloat counts every URL sharing the parameter", hygiene.find((h) => h.pattern === "?sort=")?.count === 40);
ok("dated article permalinks are not treated as calendar crawl space", !hygiene.some((h) => h.pattern.startsWith("Date-based")));

const externalOnly = detectIssues([row("https://example.com/external-only", { outlinks: 20 })], { inlinkEdges: [] });
ok("an All Inlinks graph identifies pages whose links are all external", externalOnly.some((i) => i.ruleId === "no-internal-outlinks"));
const repeatedLinks = detectIssues(
  [row("https://example.com/source"), row("https://example.com/noindex", { metaRobots: "noindex, follow", inlinks: 25 })],
  { inlinkEdges: Array.from({ length: 25 }, () => edge({ source: "https://example.com/source", target: "https://example.com/noindex" })) }
);
ok("link-count thresholds count unique referring pages, not repeated links", !repeatedLinks.some((i) => i.ruleId === "noindex-with-inlinks"));

const redirectRows = [
  row("http://example.com/", { statusCode: 301, redirectUrl: "https://example.com/" }),
  row("https://example.com/"),
  row("https://example.com/old?id=1", { statusCode: 302, redirectUrl: "https://example.com/new?id=1" }),
  row("https://example.com/old?id=2", { statusCode: 302, redirectUrl: "https://example.com/new?id=2" }),
  row("https://example.com/new?id=1"),
  row("https://example.com/new?id=2"),
  row("https://example.com/old%20name", { statusCode: 301, redirectUrl: "https://example.com/new%20name" }),
  row("https://example.com/new%20name"),
  row("https://example.com/dead-source", { statusCode: 301, redirectUrl: "https://example.com/dead-target" }),
  row("https://example.com/dead-target", { statusCode: 404 }),
];
const redirectMap = buildRedirectMap(redirectRows);
const nginx = redirectMapAsNginx(redirectMap);
const htaccess = redirectMapAsHtaccess(redirectMap);
const nextConfig = redirectMapAsNextConfig(redirectMap);
ok("known broken redirect destinations are excluded", !redirectMap.some((e) => e.source.endsWith("dead-source")));
ok("protocol upgrade guidance prevents HTTPS self-redirect deployment", nginx.includes("HTTP server block only"));
ok("Nginx matches original query strings", nginx.includes("\\?id=1") && nginx.includes("\\?id=2"));
ok("Nginx matches percent-encoded paths from the original request URI", nginx.includes("/old%20name"));
ok(".htaccess preserves temporary status and exact query conditions", htaccess.includes("R=302") && htaccess.includes("QUERY_STRING"));
ok("Next config retains distinct query conditions and does not make 302 permanent", nextConfig.includes('value: "1"') && nextConfig.includes('value: "2"') && nextConfig.includes("permanent: false"));

const priorFinding = issue({ id: "http-4xx::https://old.example/dead", url: "https://old.example/dead", verification: "CONFIRMED" });
const migratedFinding = issue({ id: "http-4xx::https://new.example/dead", url: "https://new.example/dead", verification: "CONFIRMED" });
const auditState = (issues: Issue[]) => ({ rows: [], issues } as any);
const migrationDelta = computeDelta(auditState([priorFinding]), auditState([migratedFinding]));
ok("a host migration does not report every path as newly broken and fixed", migrationDelta.newIssues.length === 0 && migrationDelta.fixedIssues.length === 0);
const resolvedDelta = computeDelta(auditState([issue({ verification: "RESOLVED" })]), auditState([]));
ok("a previously resolved false positive is not counted as fixed", resolvedDelta.fixedIssues.length === 0);

const clicksOnly = issue({ id: "http-4xx::https://example.com/clicks", url: "https://example.com/clicks", severity: "High" });
const impressionsOnly = issue({ id: "http-4xx::https://example.com/impressions", url: "https://example.com/impressions", severity: "High" });
const normalizedScores = computeImpactScores(
  [clicksOnly, impressionsOnly],
  [row(clicksOnly.url, { inlinks: 120 }), row(impressionsOnly.url, { inlinks: 120 })],
  [{ url: impressionsOnly.url, clicks: 0, impressions: 10000, ctr: 0, position: 50 }]
);
ok("impressions are log-normalized instead of dominating raw internal-link counts", Math.abs(normalizedScores[0].impactScore - normalizedScores[1].impactScore) < 10);

const fullSiteRows = [
  row("https://example.com/healthy"),
  row("https://example.com/healthy"),
  row("https://example.com/newly-broken"),
];
const fullSiteChecks = createFullSiteUrlChecks(fullSiteRows);
ok("full-site verification deduplicates crawl addresses", fullSiteChecks.length === 2);
const fullCrawlChecks = createFullSiteUrlChecks(
  Array.from({ length: 3890 }, (_, index) => row(`https://example.com/page-${index}`))
);
ok("a 3,890-address crawl queues 3,890 full-site status checks", fullCrawlChecks.length === 3890);
const newlyBroken = changedLiveStatusFinding(
  { ...fullSiteChecks[1], verification: "CONFIRMED", liveEvidence: "Live HTTP 404; crawl HTTP 200" },
  fullSiteRows[2]
);
ok("a URL that changed from crawl 200 to live 404 becomes a Critical HTTP issue", newlyBroken?.ruleId === "http-4xx" && newlyBroken.severity === "Critical");
const newlyRedirected = changedLiveStatusFinding(
  { ...fullSiteChecks[0], verification: "CONFIRMED", liveEvidence: "Live HTTP 200; crawl HTTP 200; redirect chain: 301 -> https://example.com/healthy" },
  fullSiteRows[0]
);
ok("a URL that now redirects is surfaced as a finding", newlyRedirected?.ruleId === "live-status-changed");
ok(
  "full-site summary distinguishes fetched, changed, blocked and skipped URLs",
  summarizeFullSiteChecks(
    [
      { ...fullSiteChecks[0], verification: "CONFIRMED", liveEvidence: "Live HTTP 200; crawl HTTP 200" },
      { ...fullSiteChecks[1], verification: "UNVERIFIABLE" },
    ],
    newlyBroken ? [newlyBroken] : []
  ).fetched === 1 && summarizeFullSiteChecks(
    [
      { ...fullSiteChecks[0], verification: "CONFIRMED", liveEvidence: "Live HTTP 200; crawl HTTP 200" },
      { ...fullSiteChecks[1], verification: "UNVERIFIABLE" },
    ],
    newlyBroken ? [newlyBroken] : []
  ).changed === 1
);

console.log(
  failures === 0 ? "\nALL GAP-FIX ASSERTIONS PASS\n" : `\n${failures} ASSERTION(S) FAILED\n`
);
if (failures > 0) process.exit(1);
