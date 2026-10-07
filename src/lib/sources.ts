"use client";
import { canonicalizeUrl, UrlIndex, UrlMatch } from "./url-utils";
import {
  InlinkEdge,
  InlinkSource,
  Issue,
  LinkPosition,
  SourceTraceStatus,
} from "./schema";

/**
 * Error-source tracing: for every confirmed broken URL, answer "where is this
 * URL coming from?" using three independent signals —
 *   1. the crawl link graph (All Inlinks / 4xx Inlinks export / project DB
 *      edges): which internal pages link to it, with anchor text, link type,
 *      position in the page and the XPath of the element;
 *   2. links observed in live HTML during the verification loop, which catch
 *      sources that never made it into the crawl export at all;
 *   3. the GSC URL Inspection API: which sitemaps Google found it in and which
 *      referring pages Google knows, plus its coverage state.
 *
 * Two rules govern the output:
 *   - Trace the URL the finding is ABOUT (`targetUrl ?? url`), not the page it
 *     is filed against. `live-broken-link` is filed on the linking page; tracing
 *     `url` there produced "pages that link to the linking page" under a heading
 *     that claimed to show where the broken URL comes from.
 *   - Never let "no sources" be ambiguous. "You didn't upload a link graph" and
 *     "the link graph contains nothing pointing here" are different diagnoses
 *     with different next steps, and the report has to say which one it is.
 */

/** Rules whose findings are "a URL is broken" — the ones worth tracing. */
export const ERROR_SOURCE_RULES = new Set([
  "http-4xx",
  "http-5xx",
  "redirect-broken-target",
  "link-jump-check",
  "live-broken-link",
  "malformed-concatenated-url",
  "no-response",
  "sitemap-url-broken",
  "sitemap-url-redirects",
]);

/** The URL a finding is about, which is not always the URL it is filed under. */
export function tracedUrl(issue: Issue): string {
  return issue.targetUrl ?? issue.url;
}

const MAX_SOURCE_SAMPLES = 25;

interface Bucket {
  count: number;
  byPosition: Partial<Record<LinkPosition, number>>;
  byType: Record<string, number>;
  samples: InlinkSource[];
  looseMatch: boolean;
}

function emptyBucket(): Bucket {
  return { count: 0, byPosition: {}, byType: {}, samples: [], looseMatch: false };
}

/**
 * Rank sources so the capped sample is the useful one rather than the first 25
 * encountered: richest evidence first (has XPath, has anchor), and Content-position
 * links ahead of template links — a Navigation hit is one fix, a Content hit is
 * the one someone actually has to go find.
 */
function sampleScore(s: InlinkSource): number {
  let score = 0;
  if (s.linkPath) score += 4;
  if (s.snippet) score += 3;
  if (s.anchor) score += 2;
  if (s.linkPosition === "Content") score += 2;
  if (s.origin === "live") score += 1;
  return score;
}

function addToBucket(b: Bucket, source: InlinkSource, match: UrlMatch): void {
  b.count++;
  if (match === "fuzzy") b.looseMatch = true;
  b.byPosition[s_pos(source)] = (b.byPosition[s_pos(source)] ?? 0) + 1;
  b.byType[source.linkType] = (b.byType[source.linkType] ?? 0) + 1;
  if (b.samples.length < MAX_SOURCE_SAMPLES * 4) b.samples.push(source);
}

const s_pos = (s: InlinkSource): LinkPosition => s.linkPosition ?? "Unknown";

export interface CrawlSourceTrace {
  issues: Issue[];
  /** Findings that now carry at least one source. */
  traced: number;
  /** Findings where the link graph was searched and genuinely found nothing. */
  notLinked: number;
  /** Findings matched only after loosening URL comparison — worth surfacing. */
  looseMatches: number;
}

/**
 * Attach crawl-graph sources. Pure, cheap, offline.
 *
 * `edges` may be null (no inlinks export uploaded). That is recorded on each
 * issue as `sourceTrace: "no-link-graph"` instead of leaving the source block
 * blank and indistinguishable from a genuinely unlinked URL.
 */
export function attachCrawlInlinkSources(
  issues: Issue[],
  edges: InlinkEdge[] | null | undefined
): CrawlSourceTrace {
  const traceable = issues.filter((i) => ERROR_SOURCE_RULES.has(i.ruleId));
  if (traceable.length === 0) {
    return { issues, traced: 0, notLinked: 0, looseMatches: 0 };
  }

  if (!edges || edges.length === 0) {
    return {
      issues: issues.map((i) =>
        ERROR_SOURCE_RULES.has(i.ruleId) && !i.sourceInlinkCount
          ? { ...i, sourceTrace: "no-link-graph" as SourceTraceStatus }
          : i
      ),
      traced: 0,
      notLinked: 0,
      looseMatches: 0,
    };
  }

  // Index of the URLs we want sources for. Built with UrlIndex so a trailing
  // slash, a stray fragment, a %20 vs +, http vs https or www vs apex can't
  // silently drop the join — the old `u.replace(/\/$/, "")` matched on none of those.
  const buckets = new UrlIndex<Bucket>();
  for (const i of traceable) buckets.set(tracedUrl(i), emptyBucket());

  for (const e of edges) {
    const hit = buckets.lookup(e.target);
    if (!hit.value) continue;
    // A page linking to itself is not a source worth reporting.
    if (canonicalizeUrl(e.source) === canonicalizeUrl(e.target)) continue;
    addToBucket(
      hit.value,
      {
        url: e.source,
        anchor: e.anchor || e.altText || "",
        linkType: e.linkType || "Hyperlink",
        linkPosition: e.linkPosition ?? "Unknown",
        linkPath: e.linkPath,
        linkOrigin: e.linkOrigin,
        rel: e.rel,
        follow: e.follow,
        origin: "crawl",
      },
      hit.match
    );
  }

  let traced = 0;
  let notLinked = 0;
  let looseMatches = 0;

  const out = issues.map((issue) => {
    if (!ERROR_SOURCE_RULES.has(issue.ruleId)) return issue;
    const bucket = buckets.get(tracedUrl(issue));
    if (!bucket || bucket.count === 0) {
      notLinked++;
      return {
        ...issue,
        sourceTrace: "not-linked-internally" as SourceTraceStatus,
        sourceInlinkCount: 0,
      };
    }
    traced++;
    if (bucket.looseMatch) looseMatches++;
    return mergeBucket(issue, bucket);
  });

  return { issues: out, traced, notLinked, looseMatches };
}

/** Fold a bucket into an issue, preserving anything already attached. */
function mergeBucket(issue: Issue, bucket: Bucket): Issue {
  const samples = [...bucket.samples]
    .sort((a, b) => sampleScore(b) - sampleScore(a))
    .slice(0, MAX_SOURCE_SAMPLES);

  // Keep the legacy flat list populated: the shared report, the XLSX and the
  // Jira description all still read it, and old audit JSON round-trips through it.
  const flat = samples.map((s) => {
    const bits = [s.url];
    if (s.anchor) bits.push(`anchor: "${s.anchor.slice(0, 60)}"`);
    if (s.linkType && !/hyperlink/i.test(s.linkType)) bits.push(`via ${s.linkType}`);
    if (s.linkPosition && s.linkPosition !== "Unknown") bits.push(s.linkPosition);
    return bits.join(" — ");
  });
  const existing = issue.sourceInternalInlinks ?? [];
  const merged = [...existing];
  for (const entry of flat) if (!merged.includes(entry)) merged.push(entry);

  return {
    ...issue,
    sourceTrace: "traced",
    sourceInlinkCount: (issue.sourceInlinkCount ?? 0) + bucket.count,
    sourceByPosition: mergeCounts(issue.sourceByPosition ?? {}, bucket.byPosition),
    sourceByType: mergeTypeCounts(issue.sourceByType ?? {}, bucket.byType),
    sourceSamples: dedupeSamples([...(issue.sourceSamples ?? []), ...samples]),
    sourceInternalInlinks: merged,
    sourceMatchNote: bucket.looseMatch
      ? "Matched after normalizing case/slash/protocol — confirm the exact URL form before deploying a fix."
      : issue.sourceMatchNote,
  };
}

function mergeCounts<K extends string>(
  a: Partial<Record<K, number>>,
  b: Partial<Record<K, number>>
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = { ...a };
  for (const [k, v] of Object.entries(b) as [K, number][]) {
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

function mergeTypeCounts(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function dedupeSamples(samples: InlinkSource[]): InlinkSource[] {
  const seen = new Set<string>();
  const out: InlinkSource[] = [];
  for (const s of samples) {
    const key = `${canonicalizeUrl(s.url)}|${s.linkPath ?? s.anchor}|${s.linkType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SOURCE_SAMPLES) break;
  }
  return out;
}

/**
 * Attach sources observed in live HTML during verification.
 *
 * This is the fallback that works with no extra uploads at all: the verifier
 * already fetched and parsed those pages, so the markup is in hand. It is the
 * only path in the pipeline that can produce an actual source-code snippet.
 */
export function attachLiveSources(
  issues: Issue[],
  liveSources: Map<string, InlinkSource[]>
): Issue[] {
  if (liveSources.size === 0) return issues;
  const index = new UrlIndex<InlinkSource[]>();
  for (const [target, sources] of liveSources) index.set(target, sources);

  return issues.map((issue) => {
    if (!ERROR_SOURCE_RULES.has(issue.ruleId)) return issue;
    const found = index.get(tracedUrl(issue));
    if (!found || found.length === 0) return issue;
    const bucket = emptyBucket();
    for (const s of found) addToBucket(bucket, s, "exact");
    return mergeBucket(issue, bucket);
  });
}

/**
 * Human-readable summary of a trace, for the report's source block. Returns
 * null when the finding isn't the kind that has sources.
 */
export function describeSources(issue: Issue): string | null {
  if (!ERROR_SOURCE_RULES.has(issue.ruleId)) return null;
  switch (issue.sourceTrace) {
    case "no-link-graph":
      return (
        "No link graph loaded — upload Bulk Export → Response Codes → Internal Client Error (4xx) " +
        "Inlinks (or All Inlinks) to see which pages link here."
      );
    case "not-linked-internally":
      return (
        "No internal page in the crawl links to this URL. It is reaching crawlers from somewhere " +
        "else — a sitemap, an external site, or a link rendered by JavaScript that the crawl did not execute."
      );
    case "traced": {
      const total = issue.sourceInlinkCount ?? 0;
      const positions = Object.entries(issue.sourceByPosition ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([pos, n]) => `${pos}: ${n.toLocaleString()}`)
        .join(", ");
      return `${total.toLocaleString()} internal link${total === 1 ? "" : "s"} point here${
        positions ? ` (${positions})` : ""
      }.`;
    }
    default:
      return null;
  }
}

/**
 * Group confirmed broken-link findings by the template position their sources
 * sit in. This is the view that turns the report into a sprint plan: a footer
 * link repeated across 412 pages is one ticket, not 412.
 */
export interface TemplateFixGroup {
  position: LinkPosition;
  /** Distinct broken targets reachable from this position. */
  brokenTargets: number;
  /** Total edges — the number of individual link instances. */
  edges: number;
  /** Distinct source pages affected. */
  sourcePages: number;
  sampleTarget: string;
  sampleAnchor: string;
  sampleXPath?: string;
}

export function groupFixesByTemplate(issues: Issue[]): TemplateFixGroup[] {
  const byPosition = new Map<
    LinkPosition,
    { targets: Set<string>; sources: Set<string>; edges: number; sample?: InlinkSource; sampleTarget?: string }
  >();

  for (const issue of issues) {
    if (!ERROR_SOURCE_RULES.has(issue.ruleId)) continue;
    if (issue.verification !== "CONFIRMED") continue;
    const target = tracedUrl(issue);
    for (const [pos, count] of Object.entries(issue.sourceByPosition ?? {}) as [LinkPosition, number][]) {
      const g = byPosition.get(pos) ?? { targets: new Set<string>(), sources: new Set<string>(), edges: 0 };
      g.targets.add(canonicalizeUrl(target));
      g.edges += count;
      for (const s of issue.sourceSamples ?? []) {
        if ((s.linkPosition ?? "Unknown") !== pos) continue;
        g.sources.add(canonicalizeUrl(s.url));
        if (!g.sample) {
          g.sample = s;
          g.sampleTarget = target;
        }
      }
      byPosition.set(pos, g);
    }
  }

  return [...byPosition.entries()]
    .map(([position, g]) => ({
      position,
      brokenTargets: g.targets.size,
      edges: g.edges,
      sourcePages: g.sources.size,
      sampleTarget: g.sampleTarget ?? "",
      sampleAnchor: g.sample?.anchor ?? "",
      sampleXPath: g.sample?.linkPath,
    }))
    .sort((a, b) => b.edges - a.edges);
}

/* -------------------------------------------------------------------------- */
/* GSC URL Inspection                                                           */
/* -------------------------------------------------------------------------- */

interface GscInspectResult {
  url: string;
  sitemaps: string[];
  referringPages: string[];
  coverageState?: string;
  verdict?: string;
  error?: string;
}

export interface GscSourceTrace {
  issues: Issue[];
  inspected: number;
  withSources: number;
  failures: number;
}

/**
 * Attach GSC URL Inspection sources to confirmed error issues.
 *
 * Highest-impact URLs first, unique, capped — Google's inspection quota is
 * 2,000/day per property, and one audit must never eat it. Prioritized by
 * whether the crawl graph already answered the question: a URL with zero known
 * internal sources is where an inspection call actually buys something.
 */
export async function attachGscSources(
  issues: Issue[],
  siteUrl: string,
  cap: number,
  onProgress: (done: number, total: number) => void
): Promise<GscSourceTrace> {
  const candidates = issues
    .filter((i) => ERROR_SOURCE_RULES.has(i.ruleId) && i.verification === "CONFIRMED")
    .sort((a, b) => {
      const aUnknown = (a.sourceInlinkCount ?? 0) === 0 ? 1 : 0;
      const bUnknown = (b.sourceInlinkCount ?? 0) === 0 ? 1 : 0;
      return bUnknown - aUnknown || b.impactScore - a.impactScore;
    });

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const i of candidates) {
    const u = tracedUrl(i);
    const key = canonicalizeUrl(u);
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(u);
    }
    if (urls.length >= cap) break;
  }
  if (urls.length === 0) return { issues, inspected: 0, withSources: 0, failures: 0 };

  const resultIndex = new UrlIndex<GscInspectResult>();
  let failures = 0;
  for (let b = 0; b < urls.length; b += 10) {
    const batch = urls.slice(b, b + 10);
    try {
      const res = await fetch("/api/gsc/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl, urls: batch }),
      });
      const data = (await res.json()) as { results?: GscInspectResult[]; error?: string };
      if (!res.ok || !data.results) throw new Error(data.error ?? `Inspect batch failed (${res.status})`);
      for (const r of data.results) {
        if (r.error) failures++;
        resultIndex.set(r.url, r);
      }
    } catch {
      failures += batch.length;
    }
    onProgress(Math.min(b + 10, urls.length), urls.length);
  }

  let withSources = 0;
  const out = issues.map((i) => {
    if (!ERROR_SOURCE_RULES.has(i.ruleId)) return i;
    const r = resultIndex.get(tracedUrl(i));
    if (!r || r.error) return i;
    if (r.sitemaps.length > 0 || r.referringPages.length > 0) withSources++;
    return {
      ...i,
      sourceSitemaps: r.sitemaps.length > 0 ? r.sitemaps : i.sourceSitemaps,
      sourceReferringPages: r.referringPages.length > 0 ? r.referringPages : i.sourceReferringPages,
      gscCoverageState: r.coverageState ?? i.gscCoverageState,
      sourceTrace: r.sitemaps.length > 0 || r.referringPages.length > 0 ? ("traced" as const) : i.sourceTrace,
    };
  });
  return { issues: out, inspected: urls.length, withSources, failures };
}