import { CrawlRow, Issue } from "./schema";

/**
 * Screaming Frog's "Issues Overview" export as a second input.
 *
 * This file contains NO URLs — only per-issue-type counts. So it can never
 * produce findings on its own. What it can do is far more valuable: it is the
 * ground truth to audit our own input and our own detection against.
 *
 *   1. Input integrity — SF says 14 internal 4xx; if the uploaded Internal:All
 *      only yields 2, the export is filtered/partial/stale and every number in
 *      the report is wrong. Nothing in the pipeline could detect that before.
 *   2. Column integrity — detect.ts defaults missing columns to ""/0, so an
 *      export without "Meta Description 1" silently produces zero meta
 *      findings. Cross-referencing against SF's counts surfaces that.
 *   3. Coverage map — which of SF's checks we reproduce, which we deliberately
 *      scope narrower, which we have no rule for yet (ranked by this site's
 *      real volume), and which need a different SF export entirely.
 */

export type SfIssueType = "Issue" | "Warning" | "Opportunity";
export type SfPriority = "High" | "Medium" | "Low";

export interface SfIssue {
  /** Full name as exported, e.g. "Response Codes: Internal Client Error (4xx)". */
  name: string;
  /** Left of the colon — the SF tab, e.g. "Response Codes". */
  tab: string;
  /** Right of the colon — the SF filter, e.g. "Internal Client Error (4xx)". */
  filter: string;
  type: SfIssueType;
  priority: SfPriority;
  urls: number;
  /**
   * SF's "% of Total" is a percentage of that TAB's population, not of the
   * crawl. Page Titles rows are % of internal HTML; Security rows are % of all
   * internal URLs; Images rows are % of images. Treating it as % of the crawl
   * is the single easiest way to misread this file.
   */
  pctOfTab: number;
  description: string;
  howToFix: string;
  helpUrl: string;
}

export interface IssuesOverview {
  issues: SfIssue[];
  warnings: string[];
}

/** How an AuditForge rule set relates to the SF check of the same name. */
export type Relation =
  /** Same population — counts should match. A gap means something is wrong. */
  | "exact"
  /** We deliberately flag a narrower slice (e.g. noindex only when linked). */
  | "narrower"
  /** Same idea, different cut-off — counts legitimately differ. */
  | "threshold"
  /** Covered by the live verification fetch, so only across verified URLs. */
  | "verify-time"
  /** Covered by a module rather than a detect rule. */
  | "module"
  /** No rule yet, but derivable from Internal:All columns. Build this. */
  | "buildable"
  /** Not derivable from Internal:All at all — needs another SF export. */
  | "needs-export";

export interface MapEntry {
  ruleIds: string[];
  relation: Relation;
  /** For "needs-export": the Screaming Frog export that would unlock it. */
  needs?: string;
  /** For "buildable": the Internal:All columns a new rule would read. */
  columns?: string[];
  note?: string;
}

/**
 * Screaming Frog issue name → AuditForge coverage.
 * Keys are matched case-insensitively and are stable across SF versions;
 * anything unmapped is reported as unknown rather than silently ignored.
 */
export const SF_RULE_MAP: Record<string, MapEntry> = {
  // ── Response Codes ──────────────────────────────────────────────────────
  "response codes: internal client error (4xx)": {
    ruleIds: ["http-4xx", "malformed-concatenated-url"],
    relation: "exact",
  },
  "response codes: internal server error (5xx)": { ruleIds: ["http-5xx"], relation: "exact" },
  "response codes: internal redirection (3xx)": {
    ruleIds: ["redirect-302", "redirect-chain", "redirect-loop", "redirect-broken-target"],
    relation: "narrower",
    note: "SF counts every 3xx; we only flag the harmful shapes (302, chains, loops, broken targets). A healthy 301 is not a finding.",
  },
  "response codes: internal no response": { ruleIds: ["no-response"], relation: "exact" },
  "response codes: internal blocked by robots.txt": {
    ruleIds: ["blocked-with-inlinks"],
    relation: "narrower",
    note: "We only flag blocked URLs that still receive >=3 internal links, since blocking is usually intentional.",
  },
  "response codes: external client error (4xx)": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Response Codes > External > Client Error (4xx) Inlinks",
  },
  "response codes: external server error (5xx)": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Response Codes > External > Server Error (5xx) Inlinks",
  },
  "response codes: external no response": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Response Codes > External > No Response Inlinks",
  },

  // ── Page Titles ─────────────────────────────────────────────────────────
  "page titles: missing": { ruleIds: ["title-missing"], relation: "exact" },
  "page titles: duplicate": { ruleIds: ["title-duplicate"], relation: "exact" },
  "page titles: over 60 characters": { ruleIds: ["title-long"], relation: "exact" },
  "page titles: below 30 characters": {
    ruleIds: ["title-short"],
    relation: "threshold",
    note: "Our title-short fires below 20 chars; SF's default is 30. Expect our count to be materially lower.",
  },
  "page titles: over 561 pixels": {
    ruleIds: ["title-pixels-long"],
    relation: "exact",
    columns: ["Title 1 Pixel Width"],
    note: "Needs the pixel-width column, which is not in the default export.",
  },
  "page titles: below 200 pixels": {
    ruleIds: ["title-pixels-short"],
    relation: "exact",
    columns: ["Title 1 Pixel Width"],
  },
  "page titles: same as h1": { ruleIds: ["title-equals-h1"], relation: "exact" },

  // ── Meta Description ────────────────────────────────────────────────────
  "meta description: missing": { ruleIds: ["meta-missing"], relation: "exact" },
  "meta description: duplicate": { ruleIds: ["meta-duplicate"], relation: "exact" },
  "meta description: over 155 characters": {
    ruleIds: ["meta-long"],
    relation: "threshold",
    note: "Ours fires over 160; SF's default is 155.",
  },
  "meta description: below 70 characters": { ruleIds: ["meta-short"], relation: "exact" },
  "meta description: over 985 pixels": {
    ruleIds: ["meta-pixels-long"],
    relation: "exact",
    columns: ["Meta Description 1 Pixel Width"],
  },
  "meta description: below 400 pixels": {
    ruleIds: ["meta-pixels-short"],
    relation: "exact",
    columns: ["Meta Description 1 Pixel Width"],
  },

  // ── Headings ────────────────────────────────────────────────────────────
  "h1: missing": { ruleIds: ["h1-missing"], relation: "exact" },
  "h1: multiple": { ruleIds: ["h1-multiple"], relation: "exact" },
  "h1: duplicate": { ruleIds: ["h1-duplicate"], relation: "exact" },
  "h1: over 70 characters": { ruleIds: ["h1-long"], relation: "exact" },
  "h2: missing": {
    ruleIds: ["h2-missing"],
    relation: "narrower",
    note: "Ours only fires on pages over 600 words, where missing structure actually hurts.",
  },
  "h2: multiple": {
    ruleIds: ["h2-multiple"],
    relation: "exact",
    columns: ["H2-2"],
    note: "Needs the H2-2 column, which is not in the default export.",
  },
  "h2: duplicate": { ruleIds: ["h2-duplicate"], relation: "exact" },
  "h2: over 70 characters": { ruleIds: ["h2-long"], relation: "exact" },
  "h2: non-sequential": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Internal:All does not carry heading order; SF computes this from the rendered DOM",
  },

  // ── Canonicals & Directives ─────────────────────────────────────────────
  "canonicals: missing": { ruleIds: ["canonical-missing"], relation: "exact" },
  "canonicals: canonicalised": { ruleIds: ["canonicalised"], relation: "exact" },
  "canonicals: non-indexable canonical": {
    ruleIds: ["canonical-to-non-200", "canonical-noindex-conflict"],
    relation: "narrower",
    note: "We catch canonicals pointing at non-200s and noindex conflicts; SF also counts canonicals to robots-blocked URLs.",
  },
  "directives: noindex": {
    ruleIds: ["noindex-with-inlinks"],
    relation: "narrower",
    note: "We only flag noindex pages receiving >=5 internal links — deliberate noindex is not a finding.",
  },
  "directives: nofollow": { ruleIds: ["nofollow-directive"], relation: "exact" },

  // ── Content ─────────────────────────────────────────────────────────────
  "content: low content pages": {
    ruleIds: ["thin-content"],
    relation: "threshold",
    note: "Ours fires under 150 words; SF's default is 200.",
  },
  "content: readability difficult": {
    ruleIds: ["readability-difficult"],
    relation: "exact",
    columns: ["Flesch Reading Ease Score"],
    note: "Needs the readability column, which is off by default in Screaming Frog.",
  },
  "content: readability very difficult": {
    ruleIds: ["readability-very-difficult"],
    relation: "exact",
    columns: ["Flesch Reading Ease Score"],
  },

  // ── URL hygiene (Module I) ──────────────────────────────────────────────
  "url: parameters": { ruleIds: [], relation: "module", note: "Module I parameter-bloat analysis (analyzeUrlHygiene)." },
  "url: uppercase": { ruleIds: [], relation: "module", note: "Module I mixed-case duplicate detection." },
  "url: contains space": { ruleIds: ["url-contains-space"], relation: "exact" },
  "url: non ascii characters": { ruleIds: ["url-non-ascii"], relation: "exact" },
  "url: over 115 characters": { ruleIds: ["url-too-long"], relation: "exact" },
  "url: underscores": { ruleIds: [], relation: "buildable", columns: ["Address"] },
  "url: multiple slashes": { ruleIds: [], relation: "buildable", columns: ["Address"] },

  // ── Security (Module J rides the verification fetch) ─────────────────────
  "security: missing hsts header": { ruleIds: [], relation: "verify-time" },
  "security: missing content-security-policy header": { ruleIds: [], relation: "verify-time" },
  "security: missing x-content-type-options header": { ruleIds: [], relation: "verify-time" },
  "security: missing x-frame-options header": { ruleIds: [], relation: "verify-time" },
  "security: missing secure referrer-policy header": { ruleIds: [], relation: "verify-time" },
  "security: unsafe cross-origin links": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Security > Unsafe Cross-Origin Links",
  },

  // ── Links ───────────────────────────────────────────────────────────────
  "links: pages without internal outlinks": { ruleIds: ["no-internal-outlinks"], relation: "exact" },
  "links: pages with high external outlinks": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Links > All Outlinks",
  },
  "links: internal outlinks with no anchor text": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Links > All Inlinks (already an optional input — this unlocks it)",
  },
  "links: non-descriptive anchor text in internal outlinks": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Bulk Export > Links > All Inlinks (already an optional input — this unlocks it)",
  },

  // ── Everything that needs its own export ────────────────────────────────
  "hreflang: inconsistent language & region return links": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Export > Hreflang tab (or Bulk Export > Hreflang)",
  },
  "hreflang: noindex return links": { ruleIds: [], relation: "needs-export", needs: "Export > Hreflang tab" },
  "hreflang: non-200 hreflang urls": { ruleIds: [], relation: "needs-export", needs: "Export > Hreflang tab" },
  "hreflang: not using canonical": { ruleIds: [], relation: "needs-export", needs: "Export > Hreflang tab" },
  "structured data: missing": { ruleIds: [], relation: "needs-export", needs: "Export > Structured Data tab" },
  "structured data: rich result validation errors": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Export > Structured Data tab (Validation Errors filter)",
  },
  "structured data: rich result validation warnings": {
    ruleIds: [],
    relation: "needs-export",
    needs: "Export > Structured Data tab (Validation Warnings filter)",
  },
  "images: missing alt text": { ruleIds: [], relation: "needs-export", needs: "Bulk Export > Images > Missing Alt Text Inlinks" },
  "images: alt text over 100 characters": { ruleIds: [], relation: "needs-export", needs: "Export > Images tab" },
  "images: missing size attributes": { ruleIds: [], relation: "needs-export", needs: "Export > Images tab" },
  "images: over 100 kb": { ruleIds: [], relation: "needs-export", needs: "Export > Images tab" },
  "validation: resource over 2mb": {
    ruleIds: ["oversized-resource"],
    relation: "exact",
    columns: ["Size (Bytes)"],
    note: "Needs the size column, which is not in the default export.",
  },
  "search console: no search analytics data": {
    ruleIds: [],
    relation: "module",
    note: "Covered by the GSC enrichment stage when Search Console is connected.",
  },
  "search console: non-indexable with search analytics data": {
    ruleIds: [],
    relation: "module",
    note: "Covered by the GSC enrichment stage when Search Console is connected.",
  },
};

/* ────────────────────────────── scale estimate ────────────────────────────── */

export interface ScaleCluster {
  /** Back-computed population size for this group of tabs. */
  population: number;
  tabs: string[];
  /** How many rows agreed on this figure — more is more trustworthy. */
  support: number;
}

export interface ScaleEstimate {
  clusters: ScaleCluster[];
  /** Largest cluster excluding the Response Codes tab: the internal URL count. */
  internalUrls?: number;
  /** The ~HTML-page population (Page Titles / Meta / H1 / H2 / Content tabs). */
  htmlPages?: number;
}

const HTML_TABS = new Set(["page titles", "meta description", "h1", "h2", "content", "hreflang", "structured data"]);
const ALL_URL_TABS = new Set(["security", "url"]);

/**
 * Back-compute each tab's population from `urls / pctOfTab`. Only rows with a
 * meaningful count are used: at 3 URLs and 0.01% the rounding error on the
 * percentage swamps the result.
 */
export function estimateCrawlScale(overview: IssuesOverview): ScaleEstimate {
  const points: { value: number; tab: string }[] = [];
  for (const i of overview.issues) {
    if (i.urls < 500 || i.pctOfTab <= 0) continue;
    points.push({ value: (i.urls / i.pctOfTab) * 100, tab: i.tab.toLowerCase() });
  }
  points.sort((a, b) => a.value - b.value);

  const clusters: ScaleCluster[] = [];
  for (const p of points) {
    const last = clusters[clusters.length - 1];
    // Same population if within 5% of the cluster we are building.
    if (last && Math.abs(p.value - last.population) / last.population < 0.05) {
      last.population = (last.population * last.support + p.value) / (last.support + 1);
      last.support += 1;
      if (!last.tabs.includes(p.tab)) last.tabs.push(p.tab);
    } else {
      clusters.push({ population: p.value, tabs: [p.tab], support: 1 });
    }
  }
  for (const c of clusters) c.population = Math.round(c.population);

  const pick = (match: Set<string>): number | undefined => {
    const hits = clusters.filter((c) => c.tabs.some((t) => match.has(t)));
    if (hits.length === 0) return undefined;
    return hits.sort((a, b) => b.support - a.support)[0].population;
  };

  return {
    clusters,
    internalUrls: pick(ALL_URL_TABS),
    htmlPages: pick(HTML_TABS),
  };
}

/* ────────────────────────────── reconciliation ────────────────────────────── */

export type CoverageStatus =
  | "aligned"
  | "under-detected"
  | "over-detected"
  | "narrower-by-design"
  | "threshold-difference"
  | "verify-time-only"
  | "module-covered"
  | "buildable-gap"
  | "needs-another-export"
  | "unmapped";

export interface CoverageRow {
  sf: SfIssue;
  ruleIds: string[];
  relation: Relation | "unknown";
  detected: number;
  delta: number;
  status: CoverageStatus;
  diagnosis: string;
  needs?: string;
  columns?: string[];
}

export interface IntegrityFinding {
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
}

export interface CoverageReport {
  rows: CoverageRow[];
  integrity: IntegrityFinding[];
  /** Rules worth building next, ranked by this site's real volume. */
  gaps: CoverageRow[];
  /** Grouped by the Screaming Frog export that would unlock them. */
  needsExport: { needs: string; issues: CoverageRow[]; urls: number }[];
  scale: ScaleEstimate;
  summary: {
    sfChecks: number;
    mapped: number;
    aligned: number;
    misaligned: number;
    unmapped: number;
    buildable: number;
    sfFlaggedUrls: number;
    ourFindings: number;
  };
}

const PRIORITY_WEIGHT: Record<SfPriority, number> = { High: 8, Medium: 3, Low: 1 };

/** Counts differ for legitimate reasons; only flag a gap that is real. */
function withinTolerance(ours: number, theirs: number): boolean {
  const slack = Math.max(2, theirs * 0.05);
  return Math.abs(ours - theirs) <= slack;
}

/**
 * Compare Screaming Frog's own issue counts against what AuditForge detected
 * from the Internal:All export. Pure: no fetching, no mutation.
 */
export function reconcileIssues(
  overview: IssuesOverview,
  issues: Issue[],
  rows: CrawlRow[]
): CoverageReport {
  const detectedByRule = new Map<string, number>();
  for (const i of issues) detectedByRule.set(i.ruleId, (detectedByRule.get(i.ruleId) ?? 0) + 1);

  const out: CoverageRow[] = [];
  for (const sf of overview.issues) {
    const entry = SF_RULE_MAP[sf.name.toLowerCase()];
    if (!entry) {
      out.push({
        sf,
        ruleIds: [],
        relation: "unknown",
        detected: 0,
        delta: -sf.urls,
        status: "unmapped",
        diagnosis:
          `Screaming Frog check not known to AuditForge. Either it is new in this SF version, or it belongs in ` +
          `SF_RULE_MAP. It is reported rather than dropped so the coverage figure stays honest.`,
      });
      continue;
    }

    // A URL flagged by two of our rules is still one URL to Screaming Frog.
    const urlsForRules = new Set<string>();
    for (const i of issues) if (entry.ruleIds.includes(i.ruleId)) urlsForRules.add(i.url);
    const detected = urlsForRules.size;
    const delta = detected - sf.urls;

    let status: CoverageStatus;
    let diagnosis: string;

    switch (entry.relation) {
      case "exact":
        if (withinTolerance(detected, sf.urls)) {
          status = "aligned";
          diagnosis = `Matched: Screaming Frog ${sf.urls.toLocaleString()}, AuditForge ${detected.toLocaleString()}.`;
        } else if (detected < sf.urls) {
          status = "under-detected";
          diagnosis =
            `Screaming Frog found ${sf.urls.toLocaleString()} but we detected ${detected.toLocaleString()} ` +
            `(${Math.abs(delta).toLocaleString()} short). For a same-population check that gap means the crawl export ` +
            `is filtered or stale, or a column this rule reads is absent from it.`;
        } else {
          status = "over-detected";
          diagnosis =
            `We flagged ${detected.toLocaleString()} against Screaming Frog's ${sf.urls.toLocaleString()}. ` +
            `Usually a scope difference — check whether the rule is firing on non-indexable or non-HTML URLs SF excludes.`;
        }
        break;
      case "threshold":
        status = "threshold-difference";
        diagnosis = `${entry.note ?? "Different cut-off."} Screaming Frog ${sf.urls.toLocaleString()} vs ours ${detected.toLocaleString()}.`;
        break;
      case "narrower":
        status = "narrower-by-design";
        diagnosis = `${entry.note ?? "We scope this narrower on purpose."} Screaming Frog ${sf.urls.toLocaleString()} vs ours ${detected.toLocaleString()}.`;
        break;
      case "verify-time":
        status = "verify-time-only";
        diagnosis =
          `Covered by the Module J header audit, which rides the live verification fetch — so it exists only for URLs ` +
          `that got verified, not for all ${sf.urls.toLocaleString()} Screaming Frog flagged.`;
        break;
      case "module":
        status = "module-covered";
        diagnosis = entry.note ?? "Covered by a module rather than a detection rule.";
        break;
      case "buildable":
        status = "buildable-gap";
        diagnosis =
          `No rule yet — but derivable from the Internal:All columns already in hand` +
          (entry.columns ? ` (${entry.columns.join(", ")})` : "") +
          `. ${entry.note ?? ""}`.trimEnd();
        break;
      case "needs-export":
      default:
        status = "needs-another-export";
        diagnosis = `Not derivable from Internal:All. ${entry.needs ? `Unlocked by: ${entry.needs}.` : ""}`.trim();
        break;
    }

    out.push({
      sf,
      ruleIds: entry.ruleIds,
      relation: entry.relation,
      detected,
      delta,
      status,
      diagnosis,
      needs: entry.needs,
      columns: entry.columns,
    });
  }

  const scale = estimateCrawlScale(overview);
  const integrity = buildIntegrity(out, rows, scale);

  const rank = (r: CoverageRow) => r.sf.urls * PRIORITY_WEIGHT[r.sf.priority];
  const gaps = out.filter((r) => r.status === "buildable-gap").sort((a, b) => rank(b) - rank(a));

  const byExport = new Map<string, CoverageRow[]>();
  for (const r of out) {
    if (r.status !== "needs-another-export" || !r.needs) continue;
    byExport.set(r.needs, [...(byExport.get(r.needs) ?? []), r]);
  }
  const needsExport = [...byExport.entries()]
    .map(([needs, list]) => ({ needs, issues: list, urls: list.reduce((s, r) => s + r.sf.urls, 0) }))
    .sort((a, b) => b.urls - a.urls);

  return {
    rows: out.sort((a, b) => rank(b) - rank(a)),
    integrity,
    gaps,
    needsExport,
    scale,
    summary: {
      sfChecks: out.length,
      mapped: out.filter((r) => r.relation !== "unknown").length,
      aligned: out.filter((r) => r.status === "aligned").length,
      misaligned: out.filter((r) => r.status === "under-detected" || r.status === "over-detected").length,
      unmapped: out.filter((r) => r.status === "unmapped").length,
      buildable: gaps.length,
      sfFlaggedUrls: overview.issues.reduce((s, i) => s + i.urls, 0),
      ourFindings: issues.length,
    },
  };
}

/**
 * The checks that answer "can I trust this audit at all?".
 * These are the reason the file is worth ingesting.
 */
function buildIntegrity(rows: CoverageRow[], crawl: CrawlRow[], scale: ScaleEstimate): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];

  // 1 — Is the uploaded export the whole crawl?
  if (scale.internalUrls && crawl.length > 0) {
    const ratio = crawl.length / scale.internalUrls;
    if (ratio < 0.8) {
      out.push({
        severity: "critical",
        title: "The crawl export looks incomplete",
        detail:
          `The issues report implies roughly ${scale.internalUrls.toLocaleString()} internal URLs in this crawl, but the ` +
          `uploaded export has ${crawl.length.toLocaleString()} rows — about ${Math.round(ratio * 100)}% of it. ` +
          `The usual cause is exporting a filtered view, or "Internal: HTML" instead of "Internal: All". ` +
          `Every count in this report is scoped to what was uploaded, so re-export before treating these numbers as the site total.`,
      });
    } else if (ratio > 1.25) {
      out.push({
        severity: "warn",
        title: "The crawl export is larger than the issues report implies",
        detail:
          `Export has ${crawl.length.toLocaleString()} rows against an implied ${scale.internalUrls.toLocaleString()}. ` +
          `The two files are probably from different crawls — check that they came from the same run.`,
      });
    } else {
      out.push({
        severity: "info",
        title: "Crawl export scale agrees with the issues report",
        detail: `${crawl.length.toLocaleString()} rows against an implied ${scale.internalUrls.toLocaleString()} internal URLs.`,
      });
    }
  }

  // 2 — Did a rule find nothing where SF found plenty? That is a missing column.
  const columnFor: Record<string, string> = {
    "title-missing": "Title 1",
    "title-duplicate": "Title 1",
    "title-long": "Title 1 Length",
    "meta-missing": "Meta Description 1",
    "meta-duplicate": "Meta Description 1",
    "meta-long": "Meta Description 1 Length",
    "h1-missing": "H1-1",
    "h1-multiple": "H1-2",
    "thin-content": "Word Count",
    "canonical-missing": "Canonical Link Element 1",
    "canonicalised": "Canonical Link Element 1",
  };
  const silent = rows.filter(
    (r) => r.relation === "exact" && r.detected === 0 && r.sf.urls >= 25 && r.ruleIds.length > 0
  );
  for (const r of silent) {
    const cols = r.columns && r.columns.length > 0
      ? r.columns
      : [...new Set(r.ruleIds.map((id) => columnFor[id]).filter(Boolean))];
    out.push({
      severity: "critical",
      title: `Zero findings for "${r.sf.name}" — Screaming Frog found ${r.sf.urls.toLocaleString()}`,
      detail:
        `Rule${r.ruleIds.length > 1 ? "s" : ""} ${r.ruleIds.join(", ")} produced nothing on the same crawl. ` +
        (cols.length > 0
          ? `Detection defaults an absent column to empty, so this is almost certainly a missing column in the export: ${cols.join(", ")}. `
          : "") +
        `Re-export Internal: All with these columns included.`,
    });
  }

  // 3 — Material under-detection on same-population checks.
  const short = rows.filter((r) => r.status === "under-detected" && r.detected > 0 && r.sf.urls >= 10);
  if (short.length > 0) {
    out.push({
      severity: "warn",
      title: `${short.length} check${short.length > 1 ? "s" : ""} detected below Screaming Frog's count`,
      detail: short
        .map((r) => `${r.sf.name}: SF ${r.sf.urls.toLocaleString()} vs ours ${r.detected.toLocaleString()}`)
        .join(" · "),
    });
  }

  // 4 — HTML-page population, for context on the content-side checks.
  if (scale.htmlPages) {
    const html = crawl.filter((r) => r.contentType === "" || /html/i.test(r.contentType)).length;
    if (html > 0 && html / scale.htmlPages < 0.8) {
      out.push({
        severity: "warn",
        title: "Fewer HTML pages than the issues report implies",
        detail:
          `Content-side checks (titles, metas, headings) run over ${html.toLocaleString()} HTML rows here, against an ` +
          `implied ${scale.htmlPages.toLocaleString()}. Expect every content finding to be proportionally undercounted.`,
      });
    }
  }

  return out;
}

/**
 * Screaming Frog ships a Description and a How To Fix for every issue type.
 * That is real remediation copy, free, and available with no API key — worth
 * carrying into the report for any rule we managed to map.
 */
export function remediationByRule(overview: IssuesOverview): Map<string, SfIssue> {
  const byRule = new Map<string, SfIssue>();
  for (const sf of overview.issues) {
    const entry = SF_RULE_MAP[sf.name.toLowerCase()];
    if (!entry) continue;
    for (const ruleId of entry.ruleIds) {
      // First mapping wins; "exact" beats a broader alias.
      if (!byRule.has(ruleId)) byRule.set(ruleId, sf);
    }
  }
  return byRule;
}
