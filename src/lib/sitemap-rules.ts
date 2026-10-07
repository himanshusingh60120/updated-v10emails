import {
  CrawlRow,
  GscRow,
  Issue,
  Owner,
  Severity,
  SitemapEntry,
  SitemapFetchResult,
} from "./schema";
import { canonicalizeUrl, sameSite, UrlIndex } from "./url-utils";
import { checkRobots, RobotsGroup } from "./robots";

/**
 * Module C, rebuilt as a rule engine.
 *
 * The previous implementation produced a bespoke `SitemapDiff` shape rendered
 * only inside its own report section. Those findings got no impact score, no AI
 * explanation, no Jira row, no XLSX row and no fix-tracker state — a 404 sitting
 * in the sitemap was strictly less visible than the same 404 found in the crawl.
 *
 * Emitting real `Issue` objects means everything downstream picks them up for
 * free: `computeImpactScores`, `issuesAsJiraCsv`, `exportXlsx`, the AI batching
 * in /api/analyze, and Module G re-verification.
 *
 * One classification change matters more than the rest. Sitemap URLs missing
 * from the crawl used to be filed under "in sitemap, not crawled — potential
 * orphans" whether they were healthy or dead. A 404 in your sitemap was
 * therefore reported to the team as an orphan. Orphan is now only claimed for
 * URLs that are actually reachable and indexable.
 */

export interface SitemapRuleDef {
  id: string;
  label: string;
  severity: Severity;
  owner: Owner;
}

export const SITEMAP_RULES: Record<string, SitemapRuleDef> = {
  "sitemap-file-unreadable": {
    id: "sitemap-file-unreadable",
    label: "Sitemap file could not be read",
    severity: "Critical",
    owner: "Dev",
  },
  "sitemap-not-declared-in-robots": {
    id: "sitemap-not-declared-in-robots",
    label: "Sitemap not declared in robots.txt",
    severity: "Medium",
    owner: "SEO",
  },
  "sitemap-declared-but-broken": {
    id: "sitemap-declared-but-broken",
    label: "robots.txt declares a sitemap that does not resolve",
    severity: "High",
    owner: "Dev",
  },
  "sitemap-over-nested": {
    id: "sitemap-over-nested",
    label: "Sitemap index nested more than one level deep",
    severity: "High",
    owner: "Dev",
  },
  "sitemap-file-too-large": {
    id: "sitemap-file-too-large",
    label: "Sitemap file exceeds the 50,000-URL / 50MB limit",
    severity: "High",
    owner: "Dev",
  },
  "sitemap-url-broken": {
    id: "sitemap-url-broken",
    label: "Sitemap lists a URL that returns 4xx/5xx",
    severity: "Critical",
    owner: "Dev",
  },
  "sitemap-url-redirects": {
    id: "sitemap-url-redirects",
    label: "Sitemap lists a URL that redirects",
    severity: "High",
    owner: "Dev",
  },
  "sitemap-url-noindex": {
    id: "sitemap-url-noindex",
    label: "Sitemap lists a noindex URL",
    severity: "High",
    owner: "SEO",
  },
  "sitemap-url-non-canonical": {
    id: "sitemap-url-non-canonical",
    label: "Sitemap lists a URL whose canonical points elsewhere",
    severity: "High",
    owner: "SEO",
  },
  "sitemap-url-blocked-by-robots": {
    id: "sitemap-url-blocked-by-robots",
    label: "Sitemap lists a URL blocked by robots.txt",
    severity: "High",
    owner: "SEO",
  },
  "sitemap-url-cross-domain": {
    id: "sitemap-url-cross-domain",
    label: "Sitemap lists a URL on another domain or protocol",
    severity: "High",
    owner: "Dev",
  },
  "sitemap-url-duplicate": {
    id: "sitemap-url-duplicate",
    label: "URL appears in more than one sitemap",
    severity: "Low",
    owner: "Dev",
  },
  "sitemap-url-orphan": {
    id: "sitemap-url-orphan",
    label: "In sitemap, reachable, but never linked to internally",
    severity: "Medium",
    owner: "SEO",
  },
  "sitemap-lastmod-invalid": {
    id: "sitemap-lastmod-invalid",
    label: "Sitemap <lastmod> is malformed or in the future",
    severity: "Low",
    owner: "Dev",
  },
  "sitemap-lastmod-uniform": {
    id: "sitemap-lastmod-uniform",
    label: "Every sitemap entry shares one <lastmod>",
    severity: "Medium",
    owner: "Dev",
  },
  "sitemap-missing-high-value": {
    id: "sitemap-missing-high-value",
    label: "Traffic-earning URL missing from the sitemap",
    severity: "Medium",
    owner: "SEO",
  },
  "sitemap-alternate-broken": {
    id: "sitemap-alternate-broken",
    label: "Sitemap hreflang alternate points at a broken URL",
    severity: "High",
    owner: "Dev",
  },
};

export interface SitemapAuditInput {
  sitemap: SitemapFetchResult;
  rows: CrawlRow[];
  gsc: GscRow[];
  /** Parsed robots.txt groups, keyed by origin. Enables the blocked-URL rule. */
  robotsByOrigin?: Map<string, RobotsGroup[]>;
}

export interface SitemapAuditSummary {
  totalEntries: number;
  uniqueEntries: number;
  filesFetched: number;
  filesFailed: number;
  /** Sitemap URLs the crawl knew nothing about — candidates for live checking. */
  unknownToCrawl: string[];
  /** Counts per emitted rule, for the report header. */
  countsByRule: Record<string, number>;
}

export interface SitemapAuditResult {
  issues: Issue[];
  summary: SitemapAuditSummary;
}

function makeIssue(
  ruleId: string,
  url: string,
  evidence: string,
  extra: Partial<Issue> = {}
): Issue {
  const def = SITEMAP_RULES[ruleId];
  return {
    id: `${ruleId}::${url}`,
    ruleId,
    ruleLabel: def.label,
    severity: def.severity,
    owner: def.owner,
    url,
    evidence,
    // Sitemap findings derived from crawl data are already evidence-backed:
    // the crawl fetched the URL and recorded its status. Findings that need a
    // live check are left PENDING so the verification loop picks them up.
    verification: "PENDING",
    impactScore: 0,
    fixStatus: "Open",
    ...extra,
  };
}

const isNoindex = (r: CrawlRow): boolean =>
  /noindex/i.test(r.metaRobots) || /noindex/i.test(r.indexabilityStatus);

export function auditSitemap(input: SitemapAuditInput): SitemapAuditResult {
  const { sitemap, rows, gsc, robotsByOrigin } = input;
  const issues: Issue[] = [];

  const crawl = new UrlIndex<CrawlRow>();
  for (const r of rows) crawl.set(r.url, r);

  /* ---- file-level rules ------------------------------------------------- */

  for (const f of sitemap.files) {
    if (f.kind === "unreadable") {
      issues.push(
        makeIssue(
          "sitemap-file-unreadable",
          f.url,
          `${f.error ?? "Unreadable"}${f.status ? ` (HTTP ${f.status})` : ""}${
            f.gzipped ? ", gzip body" : ""
          }. Discovered via ${f.discoveredVia}.`,
          {
            verification: "CONFIRMED",
            liveEvidence: f.error ?? "",
            verifiedAt: new Date().toISOString(),
          }
        )
      );
      // A sitemap robots.txt promises but cannot serve is worse than one that
      // was never declared: crawlers request it on every visit and get nothing.
      if (f.discoveredVia === "robots.txt") {
        issues.push(
          makeIssue(
            "sitemap-declared-but-broken",
            f.url,
            `robots.txt points crawlers at this sitemap, but it returns ${f.status || "no response"}.`,
            { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
          )
        );
      }
      continue;
    }
    if (f.depth >= 2) {
      issues.push(
        makeIssue(
          "sitemap-over-nested",
          f.url,
          `Reached at nesting depth ${f.depth}. Google reads a sitemap index one level deep; ` +
            `entries below that are ignored.`,
          { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
        )
      );
    }
    if (f.kind === "urlset" && (f.urlCount > 50_000 || f.bytes > 50 * 1024 * 1024)) {
      issues.push(
        makeIssue(
          "sitemap-file-too-large",
          f.url,
          `${f.urlCount.toLocaleString()} URLs, ${(f.bytes / 1024 / 1024).toFixed(1)}MB uncompressed. ` +
            `Limit is 50,000 URLs / 50MB. Split into an index with smaller children.`,
          { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
        )
      );
    }
  }

  if (sitemap.robotsFetched && sitemap.robotsDeclared.length === 0 && sitemap.files.length > 0) {
    const root = sitemap.files[0].url;
    issues.push(
      makeIssue(
        "sitemap-not-declared-in-robots",
        root,
        `A working sitemap exists at ${root} but robots.txt contains no "Sitemap:" line, so crawlers ` +
          `have to guess the location.`,
        { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
      )
    );
  }

  /* ---- entry-level rules ------------------------------------------------ */

  const seen = new Map<string, SitemapEntry[]>();
  for (const e of sitemap.entries) {
    const key = canonicalizeUrl(e.loc);
    const list = seen.get(key) ?? [];
    list.push(e);
    seen.set(key, list);
  }

  const siteOrigin = rows[0]?.url ?? sitemap.files[0]?.url ?? "";
  const unknownToCrawl: string[] = [];
  const lastmods = new Set<string>();
  let lastmodCount = 0;
  const now = Date.now();

  for (const [, group] of seen) {
    const entry = group[0];
    const loc = entry.loc;

    if (group.length > 1) {
      const inFiles = [...new Set(group.map((g) => g.foundIn))];
      if (inFiles.length > 1) {
        issues.push(
          makeIssue(
            "sitemap-url-duplicate",
            loc,
            `Listed in ${inFiles.length} sitemap files: ${inFiles.slice(0, 3).join(", ")}${
              inFiles.length > 3 ? ", …" : ""
            }`,
            { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
          )
        );
      }
    }

    // Cross-domain / protocol mismatch. Google ignores entries outside the
    // property the sitemap is served from.
    if (siteOrigin && !sameSite(loc, siteOrigin)) {
      issues.push(
        makeIssue(
          "sitemap-url-cross-domain",
          loc,
          `Host differs from the crawled site. Listed in ${entry.foundIn}.`,
          { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
        )
      );
      continue;
    }

    // lastmod plausibility
    if (entry.lastmod) {
      lastmodCount++;
      lastmods.add(entry.lastmod);
      const d = new Date(entry.lastmod);
      if (Number.isNaN(d.getTime())) {
        issues.push(
          makeIssue("sitemap-lastmod-invalid", loc, `<lastmod> "${entry.lastmod}" is not a valid W3C datetime.`, {
            verification: "CONFIRMED",
            verifiedAt: new Date().toISOString(),
          })
        );
      } else if (d.getTime() > now + 86_400_000) {
        issues.push(
          makeIssue("sitemap-lastmod-invalid", loc, `<lastmod> "${entry.lastmod}" is in the future.`, {
            verification: "CONFIRMED",
            verifiedAt: new Date().toISOString(),
          })
        );
      }
    }

    // robots.txt block
    if (robotsByOrigin) {
      try {
        const u = new URL(loc);
        const groups = robotsByOrigin.get(u.origin);
        if (groups) {
          const verdict = checkRobots(groups, u.pathname + u.search);
          if (!verdict.allowed) {
            issues.push(
              makeIssue(
                "sitemap-url-blocked-by-robots",
                loc,
                `Submitted in ${entry.foundIn} but disallowed by robots.txt (${verdict.matchedRule}). ` +
                  `Submitting a URL you also block is a contradictory signal.`,
                { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
              )
            );
          }
        }
      } catch {
        /* unparseable loc — the file-level rules already flagged the file */
      }
    }

    // Status / indexability from the crawl, when the crawl knows this URL.
    const row = crawl.get(loc);
    if (!row) {
      // Nothing is asserted about URLs the crawl never saw. They are handed
      // back so the caller can run them through the live verification queue —
      // calling them orphans without checking is exactly the bug this replaces.
      unknownToCrawl.push(loc);
      continue;
    }

    if (row.statusCode >= 400) {
      issues.push(
        makeIssue(
          "sitemap-url-broken",
          loc,
          `Submitted in ${entry.foundIn} but returns HTTP ${row.statusCode}.`,
          { targetUrl: loc }
        )
      );
      continue;
    }
    if (row.statusCode >= 300 && row.statusCode < 400) {
      issues.push(
        makeIssue(
          "sitemap-url-redirects",
          loc,
          `Submitted in ${entry.foundIn} but returns HTTP ${row.statusCode}` +
            (row.redirectUrl ? ` → ${row.redirectUrl}` : "") +
            `. Sitemaps should list final destinations only.`,
          { targetUrl: row.redirectUrl || loc }
        )
      );
      continue;
    }
    if (isNoindex(row)) {
      issues.push(
        makeIssue(
          "sitemap-url-noindex",
          loc,
          `Submitted in ${entry.foundIn} but carries noindex (${row.indexabilityStatus || row.metaRobots}).`
        )
      );
      continue;
    }
    if (row.canonical && canonicalizeUrl(row.canonical) !== canonicalizeUrl(loc)) {
      issues.push(
        makeIssue(
          "sitemap-url-non-canonical",
          loc,
          `Submitted in ${entry.foundIn} but its canonical points to ${row.canonical}. ` +
            `Submit the canonical version instead.`
        )
      );
      continue;
    }
    // Genuinely reachable, indexable, self-canonical — now "orphan" is a claim
    // the data supports.
    if (row.inlinks === 0 && row.statusCode === 200) {
      issues.push(
        makeIssue(
          "sitemap-url-orphan",
          loc,
          `In ${entry.foundIn}, returns 200 and is indexable, but no internal page links to it. ` +
            `The sitemap is the only way in.`
        )
      );
    }

    // hreflang alternates declared in the sitemap
    for (const alt of entry.alternates ?? []) {
      const altRow = crawl.get(alt.href);
      if (altRow && altRow.statusCode >= 400) {
        issues.push(
          makeIssue(
            "sitemap-alternate-broken",
            loc,
            `hreflang="${alt.hreflang}" alternate ${alt.href} returns HTTP ${altRow.statusCode}.`,
            { targetUrl: alt.href }
          )
        );
      }
    }
  }

  // A single shared lastmod across an entire sitemap is the classic
  // auto-generated value: it tells Google nothing and, once noticed, gets the
  // whole signal discounted.
  if (lastmodCount >= 50 && lastmods.size === 1) {
    issues.push(
      makeIssue(
        "sitemap-lastmod-uniform",
        sitemap.files.find((f) => f.kind === "urlset")?.url ?? "sitemap",
        `All ${lastmodCount.toLocaleString()} entries share <lastmod> ${[...lastmods][0]}. ` +
          `A generated timestamp carries no information and devalues the signal.`,
        { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
      )
    );
  }

  /* ---- coverage: traffic-earning URLs missing from the sitemap ----------- */

  const inSitemap = new UrlIndex<true>();
  for (const e of sitemap.entries) inSitemap.set(e.loc, true);

  const missing = gsc
    .filter((g) => g.clicks > 0 && !inSitemap.has(g.url))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 100);
  for (const g of missing) {
    issues.push(
      makeIssue(
        "sitemap-missing-high-value",
        g.url,
        `${g.clicks.toLocaleString()} clicks / ${g.impressions.toLocaleString()} impressions in the last 28 days, ` +
          `but absent from every sitemap fetched.`,
        { verification: "CONFIRMED", verifiedAt: new Date().toISOString() }
      )
    );
  }

  const countsByRule: Record<string, number> = {};
  for (const i of issues) countsByRule[i.ruleId] = (countsByRule[i.ruleId] ?? 0) + 1;

  return {
    issues,
    summary: {
      totalEntries: sitemap.entries.length,
      uniqueEntries: seen.size,
      filesFetched: sitemap.files.length,
      filesFailed: sitemap.files.filter((f) => f.kind === "unreadable").length,
      unknownToCrawl,
      countsByRule,
    },
  };
}

/**
 * Build PENDING issues for sitemap URLs the crawl never saw, so the existing
 * verification queue can live-check them and classify the result properly.
 * Capped: a 200k-URL sitemap against a 400-URL crawl must not queue 199,600 fetches.
 */
export function sitemapProbeIssues(unknownToCrawl: string[], cap = 500): Issue[] {
  return unknownToCrawl.slice(0, cap).map((url) =>
    makeIssue(
      "sitemap-url-broken",
      url,
      "Listed in the sitemap but absent from the crawl — live-checking before classifying it.",
      { targetUrl: url, severity: "Critical" }
    )
  );
}
