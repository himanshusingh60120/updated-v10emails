import { CrawlRow, GscRow, Issue, SitemapEntry } from "./schema";

/**
 * Input-integrity preflight.
 *
 * Runs on every audit, with no optional uploads required.
 *
 * The failure mode it exists for: a Screaming Frog export made while a filter or
 * search was active contains only the filtered view, and nothing in the file
 * marks it as partial. Detection then runs happily over 400 of 40,000 URLs and
 * the report presents the result with full confidence. Separately, every column
 * absent from the export defaults to ""/0, so a crawl exported without
 * "Meta Description 1" produces zero meta findings — which a reader interprets
 * as "no meta problems" rather than "never checked".
 *
 * A report that states its own blind spots can be forwarded to a team. One that
 * doesn't gets a verbal caveat attached by whoever forwards it, and the caveat
 * is what people remember.
 */

export type RuleReadiness = "checked" | "not-checked" | "partial";

export interface RuleCoverage {
  ruleIds: string[];
  label: string;
  /** Normalized fields the rules need present in the export. */
  requires: (keyof CrawlRow)[];
  readiness: RuleReadiness;
  /** Which required fields were absent. */
  missing: (keyof CrawlRow)[];
  note?: string;
}

export interface IntegritySignal {
  id: string;
  severity: "info" | "warn" | "alarm";
  message: string;
}

export interface PreflightReport {
  /** Raw headers the export carried. */
  columns: string[];
  ruleCoverage: RuleCoverage[];
  signals: IntegritySignal[];
  /** 0–100. Not a quality score — a "how much of this audit is real" score. */
  confidence: number;
  inputs: {
    crawlRows: number;
    inlinkEdges: number;
    gscRows: number;
    sitemapEntries: number;
    issuesOverview: boolean;
  };
}

/** Which export columns each family of rules actually depends on. */
const COVERAGE_MAP: Omit<RuleCoverage, "readiness" | "missing">[] = [
  {
    ruleIds: ["http-4xx", "http-5xx", "no-response"],
    label: "Response codes",
    requires: ["statusCode"],
  },
  {
    ruleIds: ["redirect-302", "redirect-chain", "redirect-loop", "redirect-broken-target"],
    label: "Redirects",
    requires: ["statusCode", "redirectUrl"],
  },
  {
    ruleIds: ["title-missing", "title-duplicate", "title-long", "title-short", "title-equals-h1"],
    label: "Page titles",
    requires: ["title", "titleLength"],
  },
  {
    ruleIds: ["meta-missing", "meta-duplicate", "meta-long", "meta-short"],
    label: "Meta descriptions",
    requires: ["metaDescription", "metaLength"],
  },
  {
    ruleIds: ["h1-missing", "h1-multiple", "h1-duplicate", "h1-long"],
    label: "H1",
    requires: ["h1", "h1Second"],
  },
  {
    ruleIds: ["h2-missing", "h2-duplicate", "h2-long", "h2-multiple"],
    label: "H2",
    requires: ["h2", "h2Second"],
  },
  {
    ruleIds: ["canonical-missing", "canonical-noindex-conflict", "canonical-to-non-200", "canonicalised"],
    label: "Canonicals",
    requires: ["canonical"],
  },
  {
    ruleIds: ["noindex-with-inlinks", "blocked-with-inlinks", "nofollow-directive"],
    label: "Indexability directives",
    requires: ["metaRobots", "indexability"],
  },
  {
    ruleIds: ["orphan-in-crawl", "no-internal-outlinks"],
    label: "Internal linking",
    requires: ["inlinks", "outlinks"],
  },
  { ruleIds: ["deep-page"], label: "Crawl depth", requires: ["crawlDepth"] },
  { ruleIds: ["thin-content"], label: "Thin content", requires: ["wordCount"] },
  { ruleIds: ["slow-response"], label: "Response time", requires: ["responseTime"] },
  {
    ruleIds: ["title-pixels-long", "title-pixels-short", "meta-pixels-long", "meta-pixels-short"],
    label: "Pixel widths",
    requires: ["titlePixels", "metaPixels"],
    note: "Not exported by default — enable both title and meta pixel columns in Screaming Frog's column config.",
  },
  {
    ruleIds: ["readability-difficult", "readability-very-difficult"],
    label: "Readability scores",
    requires: ["readability"],
    note: "Not exported by default — enable the readability column in Screaming Frog.",
  },
  {
    ruleIds: ["url-contains-space", "url-non-ascii", "url-too-long"],
    label: "URL format",
    requires: ["url"],
  },
  { ruleIds: ["oversized-resource"], label: "Resource size", requires: ["sizeBytes"] },
];

export interface PreflightInput {
  rows: CrawlRow[];
  columns: string[];
  fieldsPresent: (keyof CrawlRow)[];
  issues: Issue[];
  gsc: GscRow[];
  sitemapEntries: SitemapEntry[];
  inlinkEdges: number;
  hasIssuesOverview: boolean;
}

export function runPreflight(input: PreflightInput): PreflightReport {
  const present = new Set(input.fieldsPresent);
  const signals: IntegritySignal[] = [];

  const ruleCoverage: RuleCoverage[] = COVERAGE_MAP.map((c) => {
    const missing = c.requires.filter((f) => !present.has(f));
    const readiness: RuleReadiness =
      missing.length === 0 ? "checked" : missing.length === c.requires.length ? "not-checked" : "partial";
    return { ...c, readiness, missing };
  });

  const notChecked = ruleCoverage.filter((c) => c.readiness === "not-checked");
  for (const c of notChecked) {
    signals.push({
      id: `missing-column:${c.label}`,
      severity: "warn",
      message:
        `${c.label} was NOT checked — the export has no ${c.missing.join(", ")} column. ` +
        `Zero ${c.label.toLowerCase()} findings here means "not measured", not "clean".`,
    });
  }

  /* ---- status distribution: the filtered-export tell ---------------------- */

  const total = input.rows.length;
  const by = { ok: 0, redirect: 0, clientErr: 0, serverErr: 0, none: 0 };
  for (const r of input.rows) {
    if (r.statusCode === 0) by.none++;
    else if (r.statusCode < 300) by.ok++;
    else if (r.statusCode < 400) by.redirect++;
    else if (r.statusCode < 500) by.clientErr++;
    else by.serverErr++;
  }
  if (total >= 1_000 && by.redirect === 0 && by.clientErr === 0 && by.serverErr === 0) {
    signals.push({
      id: "all-200",
      severity: "alarm",
      message:
        `All ${total.toLocaleString()} rows returned 2xx. A crawl this size with no redirect and no error ` +
        `almost always means the export was filtered before saving. Re-export "Internal: All" with no ` +
        `filter or search active.`,
    });
  }

  const nonHtml = input.rows.filter((r) => r.contentType && !/html/i.test(r.contentType)).length;
  if (!present.has("contentType")) {
    signals.push({
      id: "no-content-type",
      severity: "warn",
      message:
        "No Content Type column, so every row is treated as HTML. PDFs, images and scripts will be " +
        "evaluated for missing titles and H1s and will inflate those counts.",
    });
  } else if (nonHtml === 0 && total > 200) {
    signals.push({
      id: "html-only",
      severity: "info",
      message:
        "Every row is HTML — this looks like an Internal: HTML export rather than Internal: All. Image, " +
        "script and PDF findings are out of scope for this audit.",
    });
  }

  /* ---- scale sanity between inputs --------------------------------------- */

  if (input.sitemapEntries.length > 0 && total > 0) {
    const ratio = input.sitemapEntries.length / total;
    if (ratio >= 5) {
      signals.push({
        id: "crawl-much-smaller-than-sitemap",
        severity: "alarm",
        message:
          `The sitemap lists ${input.sitemapEntries.length.toLocaleString()} URLs but the crawl covers ` +
          `${total.toLocaleString()}. The crawl was stopped early, limited, or filtered — findings cover ` +
          `roughly ${Math.round((1 / ratio) * 100)}% of the known site.`,
      });
    }
  }

  const gscUnknown = (() => {
    if (input.gsc.length === 0 || total === 0) return 0;
    const crawled = new Set(input.rows.map((r) => r.url.replace(/\/$/, "").toLowerCase()));
    return input.gsc.filter((g) => !crawled.has(g.url.replace(/\/$/, "").toLowerCase())).length;
  })();
  if (input.gsc.length > 100 && gscUnknown / input.gsc.length > 0.5) {
    signals.push({
      id: "gsc-mostly-uncrawled",
      severity: "warn",
      message:
        `${Math.round((gscUnknown / input.gsc.length) * 100)}% of URLs earning impressions are absent from ` +
        `the crawl. Either the crawl is partial, or Google is indexing a large surface your crawl config excludes.`,
    });
  }

  if (input.inlinkEdges === 0) {
    signals.push({
      id: "no-link-graph",
      severity: "warn",
      message:
        "No link graph loaded, so broken URLs cannot be traced to the pages that link to them. Upload " +
        "Bulk Export → Response Codes → Internal Client Error (4xx) Inlinks — it is small and answers " +
        "\u201cwhere is this 404 coming from\u201d directly.",
    });
  }

  if (!input.hasIssuesOverview) {
    signals.push({
      id: "no-issues-overview",
      severity: "info",
      message:
        "No Issues Overview export supplied, so this audit cannot be reconciled against Screaming Frog's " +
        "own counts. Reports → Issues Overview is a tiny CSV and turns every number here into a verified one.",
    });
  }

  if (by.none > 0 && by.none / Math.max(total, 1) > 0.05) {
    signals.push({
      id: "missing-status",
      severity: "warn",
      message: `${by.none.toLocaleString()} rows carry no status code. They were skipped by every status-based rule.`,
    });
  }

  /* ---- confidence --------------------------------------------------------- */

  const checkedShare =
    ruleCoverage.length === 0
      ? 1
      : ruleCoverage.filter((c) => c.readiness === "checked").length / ruleCoverage.length;
  const alarmPenalty = signals.filter((s) => s.severity === "alarm").length * 20;
  const warnPenalty = signals.filter((s) => s.severity === "warn").length * 5;
  const confidence = Math.max(0, Math.min(100, Math.round(checkedShare * 100 - alarmPenalty - warnPenalty)));

  return {
    columns: input.columns,
    ruleCoverage,
    signals,
    confidence,
    inputs: {
      crawlRows: total,
      inlinkEdges: input.inlinkEdges,
      gscRows: input.gsc.length,
      sitemapEntries: input.sitemapEntries.length,
      issuesOverview: input.hasIssuesOverview,
    },
  };
}

/** One-line verdict for the report header and for the top of any export. */
export function confidenceVerdict(report: PreflightReport): string {
  if (report.confidence >= 85) {
    return `High confidence — ${report.ruleCoverage.filter((c) => c.readiness === "checked").length}/${
      report.ruleCoverage.length
    } rule families had the columns they need.`;
  }
  if (report.confidence >= 60) {
    return "Moderate confidence — some checks could not run against this export. See the gaps listed below before acting on counts.";
  }
  return "Low confidence — this export is missing enough data that several sections are not measurements. Re-export before circulating.";
}
