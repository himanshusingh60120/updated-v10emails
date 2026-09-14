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

export interface Issue {
  id: string; // `${ruleId}::${url}`
  ruleId: string;
  ruleLabel: string;
  severity: Severity;
  owner: Owner;
  url: string;
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
  /** Same-origin links extracted from the live HTML — fuel for link-jump verification. */
  internalLinks?: string[];
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