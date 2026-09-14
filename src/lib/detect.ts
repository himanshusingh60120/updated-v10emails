import { ABSENT_SCORE, CrawlRow, Issue, Owner, Severity } from "./schema";
import { isConcatenatedUrl, splitConcatenatedUrls } from "./url-utils";

interface RuleDef {
  id: string;
  label: string;
  severity: Severity;
  owner: Owner;
  /**
   * "extended" marks a rule that is both high-volume and forces the verifier to
   * download the full document rather than just <head>. Correct, but on a large
   * site it multiplies bytes fetched, so it can be switched off in one place.
   */
  tier?: "core" | "extended";
  /** Rules that need cross-row context receive the index maps. */
  test: (row: CrawlRow, ctx: DetectContext) => string | null; // returns evidence or null
}

export interface DetectContext {
  byUrl: Map<string, CrawlRow>;
  titleCounts: Map<string, number>;
  metaCounts: Map<string, number>;
  h1Counts: Map<string, number>;
  h2Counts: Map<string, number>;
  isHtml: (r: CrawlRow) => boolean;
}

const isIndexable = (r: CrawlRow) => /indexable/i.test(r.indexability) && !/non-?indexable/i.test(r.indexability);
const isNoindex = (r: CrawlRow) => /noindex/i.test(r.metaRobots) || /noindex/i.test(r.indexabilityStatus);
const norm = (u: string) => u.replace(/\/$/, "").toLowerCase();

export const RULES: RuleDef[] = [
  {
    // Must run instead of the plain 4xx/5xx rules for these addresses, or the
    // report shows one giant unreadable URL blob under "4xx client error".
    id: "malformed-concatenated-url",
    label: "Malformed URL — multiple URLs concatenated (broken link markup)",
    severity: "Critical",
    owner: "Dev",
    test: (r) => {
      const parts = splitConcatenatedUrls(r.url);
      if (parts.length < 2) return null;
      const shown = parts.slice(0, 10);
      return (
        `This single crawled address contains ${parts.length} URLs mashed together (HTTP ${r.statusCode}, ${r.inlinks} inlinks) — ` +
        `almost always a broken <a href> in page markup (missing quote or template bug) that concatenated the URLs. ` +
        `Constituent URLs:\n` +
        shown.map((p) => `  • ${p}`).join("\n") +
        (parts.length > shown.length ? `\n  …and ${parts.length - shown.length} more` : "")
      );
    },
  },
  {
    id: "http-4xx",
    label: "4xx client error",
    severity: "Critical",
    owner: "Dev",
    test: (r) =>
      r.statusCode >= 400 && r.statusCode < 500 && !isConcatenatedUrl(r.url)
        ? `HTTP ${r.statusCode}, ${r.inlinks} internal inlinks`
        : null,
  },
  {
    id: "http-5xx",
    label: "5xx server error",
    severity: "Critical",
    owner: "Dev",
    test: (r) => (r.statusCode >= 500 && !isConcatenatedUrl(r.url) ? `HTTP ${r.statusCode}` : null),
  },
  {
    id: "redirect-302",
    label: "Temporary redirect (302) that should likely be 301",
    severity: "Medium",
    owner: "Dev",
    test: (r) =>
      r.statusCode === 302 || /302|temporary/i.test(r.redirectType)
        ? `302 → ${r.redirectUrl || "(unknown target)"}`
        : null,
  },
  {
    id: "redirect-chain",
    label: "Redirect chain (redirect pointing at another redirect)",
    severity: "High",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const next = ctx.byUrl.get(r.redirectUrl);
      if (next && next.statusCode >= 300 && next.statusCode < 400) {
        return `${r.url} → ${r.redirectUrl} → ${next.redirectUrl || "(further redirect)"}`;
      }
      return null;
    },
  },
  {
    id: "redirect-loop",
    label: "Redirect loop",
    severity: "Critical",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const seen = new Set<string>([norm(r.url)]);
      let cur = r.redirectUrl;
      for (let hop = 0; hop < 6; hop++) {
        if (seen.has(norm(cur))) return `Loop detected via ${cur}`;
        seen.add(norm(cur));
        const next = ctx.byUrl.get(cur);
        if (!next || !(next.statusCode >= 300 && next.statusCode < 400) || !next.redirectUrl) return null;
        cur = next.redirectUrl;
      }
      return null;
    },
  },
  {
    id: "redirect-broken-target",
    label: "Redirect pointing at a 4xx/5xx URL",
    severity: "Critical",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const t = ctx.byUrl.get(r.redirectUrl);
      return t && t.statusCode >= 400 ? `Redirects to ${r.redirectUrl} which returns ${t.statusCode}` : null;
    },
  },
  {
    id: "title-missing",
    label: "Missing title",
    severity: "High",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.title ? "Title tag empty or absent" : null),
  },
  {
    id: "title-duplicate",
    label: "Duplicate title",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.title || !isIndexable(r)) return null;
      const c = ctx.titleCounts.get(r.title) ?? 0;
      return c > 1 ? `"${r.title}" shared by ${c} indexable URLs` : null;
    },
  },
  {
    id: "title-long",
    label: "Title too long (> 60 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && r.titleLength > 60 ? `${r.titleLength} chars: "${r.title.slice(0, 90)}"` : null),
  },
  {
    id: "title-short",
    label: "Title too short (< 20 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.title && r.titleLength < 20
        ? `${r.titleLength} chars: "${r.title}"`
        : null,
  },
  {
    id: "meta-missing",
    label: "Missing meta description",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.metaDescription ? "Meta description absent" : null,
  },
  {
    id: "meta-duplicate",
    label: "Duplicate meta description",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.metaDescription || !isIndexable(r)) return null;
      const c = ctx.metaCounts.get(r.metaDescription) ?? 0;
      return c > 1 ? `Shared by ${c} URLs: "${r.metaDescription.slice(0, 80)}…"` : null;
    },
  },
  {
    id: "meta-long",
    label: "Meta description too long (> 160 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && r.metaLength > 160 ? `${r.metaLength} chars` : null),
  },
  {
    id: "h1-missing",
    label: "Missing H1",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.h1 ? "No H1 found on page" : null),
  },
  {
    id: "h1-multiple",
    label: "Multiple H1s",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.h1 && r.h1Second ? `H1 #1: "${r.h1.slice(0, 60)}" · H1 #2: "${r.h1Second.slice(0, 60)}"` : null,
  },
  {
    id: "h2-missing",
    label: "No H2 structure on substantial page",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.h2 && r.wordCount > 600
        ? `${r.wordCount} words with no H2 headings`
        : null,
  },
  {
    id: "canonical-missing",
    label: "Missing canonical on indexable page",
    severity: "Medium",
    owner: "Dev",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.canonical ? "No <link rel=\"canonical\"> present" : null,
  },
  {
    id: "canonical-noindex-conflict",
    label: "Canonicalized page also noindexed (conflicting signals)",
    severity: "High",
    owner: "Dev",
    test: (r) =>
      r.canonical && norm(r.canonical) !== norm(r.url) && isNoindex(r)
        ? `canonical → ${r.canonical} AND meta robots: ${r.metaRobots || r.indexabilityStatus}`
        : null,
  },
  {
    id: "canonical-to-non-200",
    label: "Canonical pointing at a non-200 URL",
    severity: "High",
    owner: "Dev",
    test: (r, ctx) => {
      if (!r.canonical) return null;
      const t = ctx.byUrl.get(r.canonical);
      return t && t.statusCode !== 200 ? `canonical → ${r.canonical} (returns ${t.statusCode})` : null;
    },
  },
  {
    id: "canonicalised",
    label: "Canonicalized to a different URL (verify intent)",
    severity: "Low",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.canonical && norm(r.canonical) !== norm(r.url)
        ? `canonical → ${r.canonical}`
        : null,
  },
  {
    id: "noindex-with-inlinks",
    label: "Noindexed page receiving internal links",
    severity: "High",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isNoindex(r) && r.inlinks >= 5
        ? `noindex (${r.metaRobots || r.indexabilityStatus}) with ${r.inlinks} inlinks`
        : null,
  },
  {
    id: "blocked-with-inlinks",
    label: "Blocked by robots.txt but receiving internal links",
    severity: "Medium",
    owner: "SEO",
    test: (r) =>
      /blocked by robots/i.test(r.indexabilityStatus) && r.inlinks >= 3
        ? `${r.indexabilityStatus}, ${r.inlinks} inlinks`
        : null,
  },
  {
    id: "orphan-in-crawl",
    label: "Page with zero internal inlinks",
    severity: "Medium",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.inlinks === 0 && r.crawlDepth > 0
        ? "0 internal inlinks (reachable only via sitemap/start URL)"
        : null,
  },
  {
    id: "deep-page",
    label: "Deep page (crawl depth > 4)",
    severity: "Low",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.crawlDepth > 4
        ? `Crawl depth ${r.crawlDepth}`
        : null,
  },
  {
    id: "thin-content",
    label: "Thin content",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.wordCount > 0 && r.wordCount < 150
        ? `${r.wordCount} words`
        : null,
  },
  {
    id: "slow-response",
    label: "Slow server response (> 1s TTFB)",
    severity: "Medium",
    owner: "Dev",
    test: (r) => (r.statusCode === 200 && r.responseTime > 1 ? `${r.responseTime.toFixed(2)}s response time` : null),
  },

  /* ────────────────────────────────────────────────────────────────────────
   * Rules added from the Screaming Frog Issues Overview gap analysis.
   * Everything above this line was in v1; everything below closes a check
   * Screaming Frog reports and AuditForge previously had no equivalent for.
   * Each reads only columns the parser already maps — the ones depending on
   * non-default export columns stay silent when those columns are absent.
   * ──────────────────────────────────────────────────────────────────────── */

  {
    // Status 0 means the request never completed: DNS failure, timeout, refused
    // connection. Screaming Frog also reports status 0 for URLs it never
    // fetched because robots.txt disallowed them — those are a different
    // finding entirely (and are covered by blocked-with-inlinks), so they must
    // be excluded here. Without this guard every robots-blocked URL on the site
    // becomes a Critical finding, jumps the verification queue, and then comes
    // back UNVERIFIABLE because robots.txt blocks the re-fetch too.
    id: "no-response",
    label: "No response (connection failed, timed out, or DNS failure)",
    severity: "Critical",
    owner: "Dev",
    test: (r) =>
      r.statusCode === 0 && !/blocked|robots|disallow/i.test(`${r.indexabilityStatus} ${r.indexability}`)
        ? `No HTTP response received, ${r.inlinks} internal inlinks`
        : null,
  },
  {
    id: "nofollow-directive",
    label: "Page-level nofollow directive",
    severity: "High",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && /\bnofollow\b/i.test(r.metaRobots)
        ? `meta robots: "${r.metaRobots}" — every outgoing link on this page is stripped of equity`
        : null,
  },
  {
    id: "no-internal-outlinks",
    label: "Page with no internal outlinks (dead end)",
    severity: "Medium",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.outlinks === 0
        ? `0 internal outlinks — link equity arrives (${r.inlinks} inlinks) and stops here`
        : null,
  },
  {
    id: "title-equals-h1",
    label: "Title identical to H1",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.title && r.h1 && r.title.trim() === r.h1.trim()
        ? `Both read "${r.title.slice(0, 80)}" — a wasted chance to target a second phrasing`
        : null,
  },
  {
    id: "h1-duplicate",
    label: "Duplicate H1 across pages",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.h1 || !isIndexable(r)) return null;
      const c = ctx.h1Counts.get(r.h1) ?? 0;
      return c > 1 ? `"${r.h1.slice(0, 70)}" shared by ${c} indexable URLs` : null;
    },
  },
  {
    id: "h1-long",
    label: "H1 over 70 characters",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.h1.length > 70
        ? `${r.h1.length} chars: "${r.h1.slice(0, 90)}"`
        : null,
  },
  {
    id: "meta-short",
    label: "Meta description under 70 characters",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.metaLength > 0 && r.metaLength < 70
        ? `${r.metaLength} chars — well short of the space the SERP will give it`
        : null,
  },
  {
    id: "h2-duplicate",
    tier: "extended",
    label: "Duplicate H2 across pages",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.h2 || !isIndexable(r)) return null;
      const c = ctx.h2Counts.get(r.h2) ?? 0;
      return c > 1 ? `"${r.h2.slice(0, 70)}" shared by ${c} indexable URLs` : null;
    },
  },
  {
    id: "h2-long",
    tier: "extended",
    label: "H2 over 70 characters",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.h2.length > 70
        ? `${r.h2.length} chars: "${r.h2.slice(0, 90)}"`
        : null,
  },
  {
    id: "url-contains-space",
    label: "URL contains a space",
    severity: "Medium",
    owner: "Dev",
    test: (r) => (/%20|\s/.test(r.url) ? `Address contains an encoded or literal space: ${r.url}` : null),
  },
  {
    id: "url-non-ascii",
    label: "URL contains non-ASCII characters",
    severity: "Low",
    owner: "Dev",
    // eslint-disable-next-line no-control-regex
    test: (r) => (/[^\x00-\x7F]/.test(r.url) ? `Address contains non-ASCII characters: ${r.url}` : null),
  },
  {
    id: "url-too-long",
    label: "URL over 115 characters",
    severity: "Low",
    owner: "SEO",
    test: (r) => (r.url.length > 115 ? `${r.url.length} characters` : null),
  },

  /* ── Rules gated on non-default export columns ───────────────────────────
   * These read columns Screaming Frog only includes when configured to. With
   * the default export they never fire, which is correct: silence beats a
   * fabricated finding. The Issues Overview cross-check reports the absence.
   */

  {
    id: "title-pixels-long",
    label: "Title over 561 pixels (truncated in the SERP)",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.titlePixels > 561
        ? `${r.titlePixels}px — past the ~561px the SERP renders: "${r.title.slice(0, 80)}"`
        : null,
  },
  {
    id: "title-pixels-short",
    label: "Title under 200 pixels",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.titlePixels > 0 && r.titlePixels < 200
        ? `${r.titlePixels}px — using a fraction of the available SERP width`
        : null,
  },
  {
    id: "meta-pixels-long",
    label: "Meta description over 985 pixels (truncated in the SERP)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.metaPixels > 985 ? `${r.metaPixels}px` : null,
  },
  {
    id: "meta-pixels-short",
    label: "Meta description under 400 pixels",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.metaPixels > 0 && r.metaPixels < 400 ? `${r.metaPixels}px` : null,
  },
  {
    id: "h2-multiple",
    tier: "extended",
    label: "Multiple H2s",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.h2 && r.h2Second
        ? `H2 #1: "${r.h2.slice(0, 50)}" · H2 #2: "${r.h2Second.slice(0, 50)}"`
        : null,
  },
  {
    id: "oversized-resource",
    label: "Resource over 2MB",
    severity: "Medium",
    owner: "Dev",
    test: (r) =>
      r.sizeBytes > 2 * 1024 * 1024
        ? `${(r.sizeBytes / 1024 / 1024).toFixed(2)}MB${r.contentType ? ` (${r.contentType})` : ""}`
        : null,
  },
  {
    id: "readability-very-difficult",
    label: "Readability very difficult",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.readability !== ABSENT_SCORE && r.readability < 30
        ? `Flesch Reading Ease ${r.readability} — college-graduate reading level`
        : null,
  },
  {
    id: "readability-difficult",
    label: "Readability difficult",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.readability !== ABSENT_SCORE && r.readability >= 30 && r.readability < 50
        ? `Flesch Reading Ease ${r.readability} — college reading level`
        : null,
  },
];

export interface DetectOptions {
  /**
   * Run the extended (full-document) content rules. On by default, which is what
   * gives parity with Screaming Frog's H2 checks. Set false on very large crawls
   * to keep every page on the cheap <head> fetch tier.
   */
  extendedContentRules?: boolean;
}

/** URLs these rules add at the full-document fetch tier — the cost of parity. */
export const EXTENDED_RULE_IDS = RULES.filter((r) => r.tier === "extended").map((r) => r.id);

export function detectIssues(rows: CrawlRow[], opts: DetectOptions = {}): Issue[] {
  const useExtended = opts.extendedContentRules ?? true;
  const active = useExtended ? RULES : RULES.filter((r) => r.tier !== "extended");
  const byUrl = new Map<string, CrawlRow>();
  const titleCounts = new Map<string, number>();
  const metaCounts = new Map<string, number>();
  const h1Counts = new Map<string, number>();
  const h2Counts = new Map<string, number>();
  const isHtml = (r: CrawlRow) => r.contentType === "" || /html/i.test(r.contentType);

  for (const r of rows) {
    byUrl.set(r.url, r);
    if (isHtml(r) && r.statusCode === 200 && isIndexable(r)) {
      if (r.title) titleCounts.set(r.title, (titleCounts.get(r.title) ?? 0) + 1);
      if (r.metaDescription) metaCounts.set(r.metaDescription, (metaCounts.get(r.metaDescription) ?? 0) + 1);
      if (r.h1) h1Counts.set(r.h1, (h1Counts.get(r.h1) ?? 0) + 1);
      if (r.h2) h2Counts.set(r.h2, (h2Counts.get(r.h2) ?? 0) + 1);
    }
  }
  const ctx: DetectContext = { byUrl, titleCounts, metaCounts, h1Counts, h2Counts, isHtml };

  const issues: Issue[] = [];
  for (const row of rows) {
    for (const rule of active) {
      let evidence: string | null = null;
      try {
        evidence = rule.test(row, ctx);
      } catch {
        evidence = null; // a single bad row must never kill detection
      }
      if (evidence) {
        issues.push({
          id: `${rule.id}::${row.url}`,
          ruleId: rule.id,
          ruleLabel: rule.label,
          severity: rule.severity,
          owner: rule.owner,
          url: row.url,
          evidence,
          verification: "PENDING",
          impactScore: 0,
          fixStatus: "Open",
        });
      }
    }
  }
  return issues;
}