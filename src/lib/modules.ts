import { CrawlRow, GscRow, Issue } from "./schema";

// ---------- Module I: crawl budget & URL hygiene ----------
export interface HygieneFinding {
  pattern: string;
  count: number;
  examples: string[];
  recommendation: string;
  robotsRule?: string;
}

export function analyzeUrlHygiene(rows: CrawlRow[]): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  const urls = rows.map((r) => r.url);

  // Parameter bloat
  const paramCounts = new Map<string, { count: number; examples: string[] }>();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      for (const key of new Set(parsed.searchParams.keys())) {
        const entry = paramCounts.get(key) ?? { count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(u);
        paramCounts.set(key, entry);
      }
    } catch {
      /* skip malformed */
    }
  }
  for (const [param, { count, examples }] of paramCounts) {
    if (count >= 20) {
      findings.push({
        pattern: `?${param}=`,
        count,
        examples: examples.slice(0, 3),
        recommendation:
          /^(sort|order|filter|color|size|price|page|view|sessionid|sid|utm_)/i.test(param)
            ? `"${param}" looks like a facet/tracking parameter generating crawlable duplicates. Block it or canonicalize parameterized URLs to the clean version.`
            : `Parameter "${param}" appears on ${count} crawled URLs. Confirm it produces distinct content; if not, block or canonicalize.`,
        robotsRule: `Disallow: /*?*${param}=`,
      });
    }
  }

  // Case duplication
  const lowerSeen = new Map<string, string>();
  let caseDupes = 0;
  const caseExamples: string[] = [];
  for (const u of urls) {
    const low = u.toLowerCase();
    const prev = lowerSeen.get(low);
    if (prev && prev !== u) {
      caseDupes++;
      if (caseExamples.length < 3) caseExamples.push(`${prev} ⇄ ${u}`);
    } else lowerSeen.set(low, u);
  }
  if (caseDupes > 0)
    findings.push({
      pattern: "Mixed-case duplicates",
      count: caseDupes,
      examples: caseExamples,
      recommendation: "Enforce lowercase URLs with a single 301 rule at the edge and update internal links.",
    });

  // Trailing-slash duplication
  let slashDupes = 0;
  const slashExamples: string[] = [];
  const set = new Set(urls);
  for (const u of urls) {
    if (u.endsWith("/") && set.has(u.slice(0, -1))) {
      slashDupes++;
      if (slashExamples.length < 3) slashExamples.push(u);
    }
  }
  if (slashDupes > 0)
    findings.push({
      pattern: "Trailing-slash duplicates",
      count: slashDupes,
      examples: slashExamples,
      recommendation: "Pick one form (with or without trailing slash) and 301 the other site-wide.",
    });

  // http/https duplication
  let protoDupes = 0;
  for (const u of urls) {
    if (u.startsWith("http://") && set.has(u.replace(/^http:/, "https:"))) protoDupes++;
  }
  if (protoDupes > 0)
    findings.push({
      pattern: "http:// duplicates of https:// URLs",
      count: protoDupes,
      examples: urls.filter((u) => u.startsWith("http://")).slice(0, 3),
      recommendation: "Force HTTPS with a blanket 301 and add HSTS (see header audit).",
    });

  // Flag calendar/archive endpoints, not ordinary dated article permalinks.
  const calendar = urls.filter((u) => /\/\d{4}\/(?:0?[1-9]|1[0-2])(?:\/(?:0?[1-9]|[12]\d|3[01]))?(?:\/page\/\d+)?\/?(?:[?#].*)?$/.test(u));
  if (calendar.length >= 50)
    findings.push({
      pattern: "Date-based archive paths (/YYYY/MM/…)",
      count: calendar.length,
      examples: calendar.slice(0, 3),
      recommendation:
        "Date archives can be an infinite crawl space. Confirm they earn traffic; otherwise noindex or prune from internal linking.",
    });

  return findings.sort((a, b) => b.count - a.count);
}

// ---------- Module C: sitemap intelligence ----------
export interface SitemapDiff {
  inSitemapNotCrawled: string[];
  sitemapPollution: { url: string; reason: string }[];
  gscMissingFromSitemap: { url: string; clicks: number }[];
}

export function diffSitemap(
  sitemapUrls: string[],
  rows: CrawlRow[],
  gsc: GscRow[]
): SitemapDiff {
  const crawlSet = new Set(rows.map((r) => r.url.replace(/\/$/, "")));
  const sitemapSet = new Set(sitemapUrls.map((u) => u.replace(/\/$/, "")));
  const byUrl = new Map(rows.map((r) => [r.url.replace(/\/$/, ""), r]));

  const inSitemapNotCrawled = sitemapUrls.filter((u) => !crawlSet.has(u.replace(/\/$/, ""))).slice(0, 500);
  const sitemapPollution: { url: string; reason: string }[] = [];
  for (const u of sitemapUrls) {
    const row = byUrl.get(u.replace(/\/$/, ""));
    if (!row) continue;
    if (row.statusCode !== 200) sitemapPollution.push({ url: u, reason: `returns ${row.statusCode}` });
    else if (/non-?indexable/i.test(row.indexability))
      sitemapPollution.push({ url: u, reason: row.indexabilityStatus || "non-indexable" });
  }
  const gscMissingFromSitemap = gsc
    .filter((g) => g.clicks > 0 && !sitemapSet.has(g.url.replace(/\/$/, "")))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 100)
    .map((g) => ({ url: g.url, clicks: g.clicks }));

  return { inSitemapNotCrawled, sitemapPollution: sitemapPollution.slice(0, 500), gscMissingFromSitemap };
}

// ---------- Module M: redirect map + dev handoff ----------
export interface RedirectEntry {
  source: string;
  finalDestination: string;
  hops: number;
  sourceStatus: number;
}

export function buildRedirectMap(rows: CrawlRow[]): RedirectEntry[] {
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const entries: RedirectEntry[] = [];
  for (const r of rows) {
    if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) continue;
    let cur = r.redirectUrl;
    let hops = 1;
    const seen = new Set([r.url]);
    while (hops < 10) {
      const next = byUrl.get(cur);
      if (!next || !(next.statusCode >= 300 && next.statusCode < 400) || !next.redirectUrl) break;
      if (seen.has(cur)) break; // loop; leave as-is, flagged elsewhere
      seen.add(cur);
      cur = next.redirectUrl;
      hops++;
    }
    const destination = byUrl.get(cur);
    if (destination && destination.statusCode >= 400) continue;
    entries.push({ source: r.url, finalDestination: cur, hops, sourceStatus: r.statusCode });
  }
  return entries;
}

function pathOf(u: string): string {
  try {
    const p = new URL(u);
    return p.pathname + p.search;
  } catch {
    return u;
  }
}

export function redirectMapAsNginx(map: RedirectEntry[]): string {
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    "# Review before deployment. Apply each rule only in the source host's HTTP/HTTPS server context.",
    ...map.map((e) => {
      const source = new URL(e.source);
      const destination = new URL(e.finalDestination);
      const sourcePath = source.pathname + source.search;
      const query = source.search ? "" : "(?:\\?.*)?";
      const pattern = `^${escapeRegex(sourcePath)}${query}$`;
      const status = [301, 302, 303, 307, 308].includes(e.sourceStatus) ? e.sourceStatus : 301;
      const protocolOnly = source.protocol === "http:" && destination.protocol === "https:" && sourcePath === destination.pathname + destination.search;
      return [
        `# ${source.host}: ${sourcePath} -> ${e.finalDestination} (${status})`,
        protocolOnly ? "# Install this rule in the HTTP server block only; do not include it in HTTPS." : "",
        `if ($request_uri ~ "${pattern}") { return ${status} ${e.finalDestination}; }`,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

export function redirectMapAsHtaccess(map: RedirectEntry[]): string {
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    "# Requires mod_rewrite. Review source host, path and status before deployment.",
    ...map.map((e) => {
      const source = new URL(e.source);
      const sourcePath = escapeRegex(source.pathname.replace(/^\//, ""));
      const query = escapeRegex(source.search.slice(1));
      const status = [301, 302, 303, 307, 308].includes(e.sourceStatus) ? e.sourceStatus : 301;
      return [
        `# ${source.host}: ${source.pathname}${source.search} -> ${e.finalDestination}`,
        `RewriteCond %{QUERY_STRING} ^${query}$`,
        `RewriteRule ^${sourcePath}$ ${e.finalDestination} [R=${status},L,QSD]`,
      ].join("\n");
    }),
  ].join("\n");
}

export function redirectMapAsNextConfig(map: RedirectEntry[]): string {
  const items = map
    .map(
      (e) => {
        const source = new URL(e.source);
        const has = [...source.searchParams.entries()].map(([key, value]) =>
          `      { type: "query", key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} },`
        );
        const permanent = e.sourceStatus === 301 || e.sourceStatus === 308;
        return [
          `    { source: ${JSON.stringify(source.pathname)}, destination: ${JSON.stringify(e.finalDestination)}, permanent: ${permanent},`,
          ...(has.length ? [`      has: [`, ...has, `      ],`] : []),
          `    },`,
        ].join("\n");
      }
    )
    .join("\n");
  return `// Review source hosts, destination status and query matching before deployment.\nmodule.exports = {\n  async redirects() {\n    return [\n${items}\n    ];\n  },\n};\n`;
}

export function issuesAsJiraCsv(issues: Issue[]): string {
  const priority: Record<string, string> = { Critical: "Highest", High: "High", Medium: "Medium", Low: "Low" };
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = "Summary,Description,Priority,Labels";
  const lines = issues
    .filter((i) => i.verification === "CONFIRMED")
    .map((i) =>
      [
        esc(`[SEO] ${i.ruleLabel}: ${i.url}`),
        esc(
          `URL: ${i.url}\nIssue: ${i.ruleLabel}\nEvidence (crawl): ${i.evidence}\nEvidence (live, verified ${i.verifiedAt ?? ""}): ${
            i.liveEvidence ?? ""
          }\nImpact score: ${i.impactScore}` +
            (i.sourceSitemaps?.length ? `\nSource sitemaps (GSC): ${i.sourceSitemaps.join(", ")}` : "") +
            (i.sourceReferringPages?.length ? `\nSource referring pages (GSC): ${i.sourceReferringPages.join(", ")}` : "") +
            (i.sourceInternalInlinks?.length ? `\nInternal pages linking here: ${i.sourceInternalInlinks.join(", ")}` : "")
        ),
        priority[i.severity],
        esc(`seo,auditforge,team-${i.owner.toLowerCase()},${i.ruleId}`),
      ].join(",")
    );
  return [header, ...lines].join("\n");
}
