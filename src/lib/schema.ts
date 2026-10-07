import { z } from "zod";

/** Sentinel for a score column that was not in the export. Outside any real Flesch value. */
export const ABSENT_SCORE = -999;

/** One normalized crawl row. Every input format maps into this. */
export const CrawlRowSchema = z.object({
  url: z.string().url(),
  statusCode: z.number().int().min(0).max(999),
  indexability: z.string().default(""),
  indexabilityStatus: z.string().default(""),
  title: z.string().default(""),
  titleLength: z.number().int().nonnegative().default(0),
  metaDescription: z.string().default(""),
  metaLength: z.number().int().nonnegative().default(0),
  h1: z.string().default(""),
  h1Second: z.string().default(""),
  h2: z.string().default(""),
  canonical: z.string().default(""),
  metaRobots: z.string().default(""),
  wordCount: z.number().int().nonnegative().default(0),
  crawlDepth: z.number().int().default(0),
  inlinks: z.number().int().nonnegative().default(0),
  outlinks: z.number().int().nonnegative().default(0),
  responseTime: z.number().nonnegative().default(0),
  contentType: z.string().default(""),
  redirectUrl: z.string().default(""),
  redirectType: z.string().default(""),

  /**
   * Columns Screaming Frog can export but does not by default. Each defaults to
   * an "absent" value so an export without them parses unchanged and the rules
   * that read them simply stay silent.
   */
  titlePixels: z.number().int().nonnegative().default(0),
  metaPixels: z.number().int().nonnegative().default(0),
  h2Second: z.string().default(""),
  sizeBytes: z.number().nonnegative().default(0),
  /**
   * Flesch Reading Ease. Legitimately spans negatives, and 0 means "very hard"
   * rather than "unknown", so absence needs a sentinel outside the real range
   * instead of the usual 0 — otherwise a missing column reads as every page
   * being unreadable.
   */
  readability: z.number().default(ABSENT_SCORE),
});
export type CrawlRow = z.infer<typeof CrawlRowSchema>;

export const Severity = z.enum(["Critical", "High", "Medium", "Low"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  Critical: 8,
  High: 4,
  Medium: 2,
  Low: 1,
};

export type Owner = "Dev" | "Content" | "SEO";

export type VerificationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "RESOLVED"
  | "UNVERIFIABLE"
  | "SKIPPED";

export type FixStatus = "Open" | "In Progress" | "Fixed-Claimed" | "Fixed-Verified";

/**
 * Where a link lives in the page it was found on. Screaming Frog emits these
 * verbatim in the "Link Position" column; the live verifier derives the same
 * vocabulary from the nearest landmark ancestor so both sources agree.
 *
 * This is the field that turns a 900-row broken-link list into a work plan:
 * `Navigation: 412` means one template change closes 412 findings.
 */
export type LinkPosition =
  | "Navigation"
  | "Header"
  | "Footer"
  | "Sidebar"
  | "Aside"
  | "Content"
  | "Unknown";

export function normalizeLinkPosition(raw: string): LinkPosition {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "Unknown";
  if (/nav/.test(s)) return "Navigation";
  if (/head/.test(s)) return "Header";
  if (/foot/.test(s)) return "Footer";
  if (/sidebar/.test(s)) return "Sidebar";
  if (/aside/.test(s)) return "Aside";
  if (/content|body|main/.test(s)) return "Content";
  return "Unknown";
}

/**
 * One edge of the internal link graph.
 *
 * Previously `{ source, target, anchor }` — which is why the report could say
 * "this URL is 404" but never "and here is the markup that points at it".
 * Everything past `anchor` comes free in the Screaming Frog All Inlinks export
 * and was being discarded at parse time.
 */
export interface InlinkEdge {
  source: string;
  target: string;
  anchor: string;
  /** SF "Type": Hyperlink, Image, Canonical, Redirect, Hreflang, JS, CSS, … */
  linkType?: string;
  /** SF "Link Position", normalized. */
  linkPosition?: LinkPosition;
  /** SF "Link Path" — the XPath of the element. The literal source location. */
  linkPath?: string;
  /** SF "Link Origin" — HTML vs Rendered (JS-injected). */
  linkOrigin?: string;
  /** SF "Alt Text" — the anchor equivalent for image edges. */
  altText?: string;
  /** SF "Follow" — false for rel=nofollow. */
  follow?: boolean;
  /** SF "Rel" — ugc / sponsored / nofollow. Changes who owns the fix. */
  rel?: string;
  /** SF "Status Code" for the destination — a free cross-check on detection. */
  edgeStatus?: number;
  /** Markup snippet, when the edge came from a live fetch rather than a CSV. */
  snippet?: string;
}

/** A single traced source, rendered in the report and exported per-row. */
export interface InlinkSource {
  url: string;
  anchor: string;
  linkType: string;
  linkPosition: LinkPosition;
  linkPath?: string;
  linkOrigin?: string;
  rel?: string;
  follow?: boolean;
  snippet?: string;
  /** "crawl" (All Inlinks / 4xx Inlinks export) or "live" (verification fetch). */
  origin: "crawl" | "live";
}

/** Why a source trace produced nothing — never left ambiguous in the report. */
export type SourceTraceStatus =
  | "traced"
  | "no-link-graph"
  | "not-linked-internally"
  | "not-applicable";

export interface Issue {
  id: string; // `${ruleId}::${url}`
  ruleId: string;
  ruleLabel: string;
  severity: Severity;
  owner: Owner;
  url: string;
  /**
   * The URL the finding is *about*, when that differs from the page the finding
   * is filed against. `live-broken-link` is filed on the linking page but is
   * about the broken target; `redirect-broken-target` is filed on the redirect
   * but is about its destination. Source tracing follows this, not `url` —
   * without it the report traced inlinks to the wrong URL and labelled the
   * result "where this broken URL comes from".
   */
  targetUrl?: string;
  /** The actual value found in the crawl that triggered the rule. */
  evidence: string;
  /** Populated by the verification loop from live source. */
  liveEvidence?: string;
  verification: VerificationStatus;
  verifiedAt?: string;
  verifyError?: string;
  impactScore: number;
  fixStatus: FixStatus;
  gscClicks?: number;
  gscImpressions?: number;
  /** Error source — sitemaps GSC knows this URL from (URL Inspection API). */
  sourceSitemaps?: string[];
  /** Error source — referring pages GSC knows for this URL (URL Inspection API). */
  sourceReferringPages?: string[];
  /** Error source — internal pages linking here, from the crawl link graph (All Inlinks / project DB). */
  sourceInternalInlinks?: string[];
  /** Total edges pointing at this URL. A 404 linked once and one linked 900 times are not the same job. */
  sourceInlinkCount?: number;
  /** Edge count by position — `{ Navigation: 412, Content: 3 }`. Drives the "fix by template" view. */
  sourceByPosition?: Partial<Record<LinkPosition, number>>;
  /** Edge count by link type — `{ Hyperlink: 400, Image: 16, Canonical: 1 }`. */
  sourceByType?: Record<string, number>;
  /** Richest sources, capped. Carries anchor, XPath and markup for the ticket. */
  sourceSamples?: InlinkSource[];
  /** Whether tracing ran, and if it found nothing, why. Never left implicit. */
  sourceTrace?: SourceTraceStatus;
  /** Set when the source index matched loosely, so the report can say so. */
  sourceMatchNote?: string;
  /** GSC coverage state for the URL, e.g. "URL is unknown to Google" / "Crawled - currently not indexed". */
  gscCoverageState?: string;
}

export interface HeaderFinding {
  url: string;
  check: string;
  grade: "pass" | "warn" | "fail";
  detail: string;
}

/** One rule to re-check against a single live fetch of the parent page. */
export interface VerifyCheck {
  issueId: string;
  ruleId: string;
  crawlEvidence: string;
  expected?: string;
}

/**
 * Verification is requested per **URL**, not per issue. Every rule flagged
 * against a URL is re-checked from one fetch and one parse of that page.
 */
export interface VerifyPageRequest {
  url: string;
  checks: VerifyCheck[];
  /** Opt into same-origin link harvesting only for selected pages. */
  collectLinks?: boolean;
}

export interface VerifyResultItem {
  issueId: string;
  status: Exclude<VerificationStatus, "PENDING">;
  liveEvidence: string;
  verifyError?: string;
  finalStatusCode?: number;
  redirectChain?: string[];
  headerFindings?: HeaderFinding[];
  mixedContentCount?: number;
  hasJsonLd?: boolean;
  /**
   * Same-origin links extracted from the live HTML — fuel for link-jump
   * verification. Structured rather than bare strings: the DOM is already
   * parsed at this point, so capturing the markup, the anchor and the landmark
   * the link sits in costs nothing and is the only place in the pipeline where
   * source-code evidence can be obtained. The linking page is never fetched
   * anywhere else.
   */
  internalLinks?: LiveLink[];
}

/** One same-origin link observed in live HTML, with its source-code context. */
export interface LiveLink {
  url: string;
  anchor: string;
  /** `outerHTML` of the element, truncated — pasteable straight into a ticket. */
  snippet: string;
  position: LinkPosition;
  /** Hyperlink / Image / Iframe / Canonical / Hreflang / Form Action / Media. */
  linkType: string;
  rel?: string;
  follow?: boolean;
}

/** Measured Active CPU, echoed back so the client can govern its own spend. */
export interface VerifyMeter {
  instanceId: string;
  instanceCpuMs: number;
  requestCpuMs: number;
  wallMs: number;
  /** Pages served from the live-state cache instead of refetched. */
  cacheHits: number;
  /** Pages where the body was never downloaded because no rule needed it. */
  bodySkipped: number;
  /** Pages where only <head> was read instead of the whole document. */
  headOnly: number;
}

export interface VerifyResponse {
  results: VerifyResultItem[];
  meter: VerifyMeter;
}

const VerifyCheckSchema = z.object({
  issueId: z.string().min(1),
  ruleId: z.string().min(1),
  crawlEvidence: z.string().default(""),
  expected: z.string().optional(),
});

export const VerifyRequestSchema = z.object({
  pages: z
    .array(
      z.object({
        url: z.string().url(),
        checks: z.array(VerifyCheckSchema).min(1).max(40),
        collectLinks: z.boolean().optional(),
      })
    )
    .min(1)
    .max(12),
  /**
   * Politeness delay between pages. Defaults to 0: pacing belongs on the
   * client, where sleeping is free, not inside a function whose wall-clock
   * time is billed as Provisioned Memory.
   */
  delayMs: z.number().int().min(0).max(5000).default(0),
  /** Harvest same-origin <a href> for link-jump. Costs a full DOM walk. */
  collectLinks: z.boolean().default(false),
  /** Run the Module J header audit. Free on the fetch, but adds response weight. */
  collectHeaders: z.boolean().default(true),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const AnalyzeRequestSchema = z.object({
  groups: z
    .array(
      z.object({
        ruleId: z.string(),
        ruleLabel: z.string(),
        severity: Severity,
        count: z.number().int().positive(),
        sampleUrls: z.array(z.string()).max(5),
        sampleEvidence: z.array(z.string()).max(5),
      })
    )
    .min(1)
    .max(40),
  siteStats: z.object({
    totalUrls: z.number(),
    confirmed: z.number(),
    resolved: z.number(),
    unverifiable: z.number(),
    healthScore: z.number(),
  }),
});

export interface RuleAnalysis {
  ruleId: string;
  explanation: string;
  rootCause: string;
  fixSteps: string[];
  codeSnippet: string;
  effort: "S" | "M" | "L";
  owner: Owner;
}

export interface ExecSummary {
  grade: string;
  narrative: string;
  topPriorities: string[];
  projectedImpact: string;
  actionPlan30Day: string[];
}

export interface GscRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/* -------------------------------------------------------------------------- */
/* Sitemap                                                                      */
/* -------------------------------------------------------------------------- */

/** One `<url>` entry, with everything the XML actually carried. */
export interface SitemapEntry {
  loc: string;
  /** The sitemap file this entry came from — an index can have 60 children. */
  foundIn: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
  /** hreflang alternates declared via `<xhtml:link rel="alternate">`. */
  alternates?: { hreflang: string; href: string }[];
  /** True for image:/video:/news: extension entries rather than plain page URLs. */
  extension?: "image" | "video" | "news";
}

/** One fetched sitemap file and how it behaved. */
export interface SitemapFile {
  url: string;
  status: number;
  contentType: string;
  /** True when the body arrived gzipped and had to be inflated. */
  gzipped: boolean;
  /** Bytes after inflation — the number the 50MB limit actually applies to. */
  bytes: number;
  kind: "index" | "urlset" | "unreadable";
  urlCount: number;
  /** Nesting depth: 0 for a root, 1 for a child of an index, 2+ is over-nested. */
  depth: number;
  error?: string;
  /** How this file was found: robots.txt, a sitemap index, a probe, or the user. */
  discoveredVia: "robots.txt" | "sitemap-index" | "probe" | "manual";
}

export interface SitemapFetchResult {
  entries: SitemapEntry[];
  files: SitemapFile[];
  /** Every `Sitemap:` line seen in robots.txt, whether or not it resolved. */
  robotsDeclared: string[];
  robotsStatus: number;
  robotsFetched: boolean;
  truncated: boolean;
  warnings: string[];
}

export const SitemapRequestSchema = z.object({
  /** Explicit sitemap URLs. Optional once `origin` is supplied. */
  urls: z.array(z.string().url()).max(50).default([]),
  /** Site origin — enables robots.txt discovery and well-known probing. */
  origin: z.string().url().optional(),
  /** Skip discovery and use `urls` verbatim. */
  manualOnly: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(200).default(60),
  maxUrls: z.number().int().min(1).max(500_000).default(200_000),
});
export type SitemapRequest = z.infer<typeof SitemapRequestSchema>;

export interface AuditState {
  meta: { createdAt: string; name: string; auditId: string };
  rows: CrawlRow[];
  issues: Issue[];
  headerFindings: HeaderFinding[];
  gsc: GscRow[];
  sitemapUrls: string[];
  inlinksLoaded: boolean;
  pagerank?: PagerankReport;
  analyses?: RuleAnalysis[];
  execSummary?: ExecSummary;
  parseWarnings: string[];
  /** Active CPU this audit spent on verification, in ms. Shown in the report. */
  cpuMs?: number;
  /**
   * Screaming Frog's own Issues Overview, when supplied. Optional on purpose:
   * audits saved before this input existed still deserialize cleanly.
   */
  issuesOverview?: import("./issues-overview").IssuesOverview;
  coverage?: import("./issues-overview").CoverageReport;
  /**
   * Full sitemap detail. `sitemapUrls` above is kept as a flat list of `loc`
   * values so audits saved before this existed still deserialize and still
   * feed Module C.
   */
  sitemapEntries?: SitemapEntry[];
  sitemapFiles?: SitemapFile[];
  sitemapRobotsDeclared?: string[];
  /**
   * Input-integrity preflight: which columns the export actually carried, and
   * therefore which rules genuinely passed versus were never able to run.
   */
  preflight?: import("./preflight").PreflightReport;
}

export interface PagerankReport {
  topPages: { url: string; pr: number }[];
  equityLeaks: { source: string; target: string; anchor: string; sourcePr: number; problem: string }[];
  deadEnds: { url: string; pr: number }[];
  opportunities: { target: string; suggestedSource: string; anchor: string; reason: string }[];
}

export function severityRank(s: Severity): number {
  return { Critical: 0, High: 1, Medium: 2, Low: 3 }[s];
}