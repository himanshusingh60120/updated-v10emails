import { NextRequest, NextResponse } from "next/server";
import { parse as parseHtml, HTMLElement } from "node-html-parser";
import { checkRobots, parseRobotsTxt, RobotsGroup } from "@/lib/robots";
import { startMeter } from "@/lib/cpu-meter";
import {
  HeaderFinding,
  LinkPosition,
  LiveLink,
  VerifyCheck,
  VerifyMeter,
  VerifyRequestSchema,
  VerifyResultItem,
} from "@/lib/schema";
import { isConcatenatedUrl } from "@/lib/url-utils";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA = process.env.VERIFY_USER_AGENT || "Mozilla/5.0 (compatible; AuditForgeBot/1.0; SEO audit verification)";
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_TIMEOUT_MS = 6_000;
const MAX_HOPS = 5;

/**
 * How much HTML we are willing to hold and parse.
 *
 * The old ceiling was 2 MB. Parsing 2 MB with node-html-parser costs roughly
 * 40–90 ms of Active CPU per page; on a 93k-row crawl that is the single
 * largest line item on the bill. Nothing above ~512 KB has ever changed a
 * verdict here — titles, metas, canonicals and H1s all live in the first few
 * KB — so we cap and move on.
 */
const MAX_HTML_BYTES = 512 * 1024;
/** <head> is all most rules need, and it is almost always under 32 KB. */
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_LINKS_PER_PAGE = 150;

/* -------------------------------------------------------------------------- */
/* Capability gating — the core CPU saving                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each rule actually needs from the live response:
 *
 *   status — the final status code and redirect chain. No body download at all.
 *   head   — <title>, <meta>, <link rel=canonical>. Stream-read up to </head>.
 *   dom    — elements in <body> (H1s). Full parse.
 *   text   — the raw document as a string (word counts, H2 presence). Full read,
 *            regex only, no DOM.
 *
 * A page is fetched at the highest tier any of its rules requires, and no
 * higher. Most 4xx/5xx/redirect findings — usually the bulk of a large audit —
 * now cost one HEAD-ish request and zero parsing.
 */
type Capability = "status" | "head" | "dom" | "text";

const RULE_CAPS: Record<string, Capability> = {
  // A repaired 4xx may now return a 200 challenge page, so read <head> to
  // distinguish a real resolution from a WAF interstitial.
  "http-4xx": "head",
  "http-5xx": "status",
  "redirect-302": "status",
  "redirect-chain": "status",
  "redirect-loop": "status",
  "redirect-broken-target": "status",
  "slow-response": "status",
  "malformed-concatenated-url": "status",
  "link-jump-check": "status",
  "full-site-url-check": "status",
  "orphan-in-crawl": "status",
  "deep-page": "status",

  "title-missing": "head",
  "title-long": "head",
  "title-short": "head",
  "title-duplicate": "head",
  "meta-missing": "head",
  "meta-long": "head",
  "meta-duplicate": "head",
  "canonical-missing": "head",
  "canonical-noindex-conflict": "head",
  "canonical-to-non-200": "head",
  canonicalised: "head",
  "noindex-with-inlinks": "head",
  "blocked-with-inlinks": "head",

  "h1-missing": "dom",
  "h1-multiple": "dom",

  "h2-missing": "text",
  "thin-content": "text",

  // ── Added with the Screaming Frog gap rules ────────────────────────────
  // Deliberately cheap where a live fetch cannot re-derive the finding:
  // pixel widths and Flesch scores are computed by Screaming Frog, not by us,
  // so those rules take the structural default branch at zero body cost
  // rather than pretending to re-measure something we never measured.
  "no-response": "status",
  "url-contains-space": "status",
  "url-non-ascii": "status",
  "url-too-long": "status",
  "oversized-resource": "status",
  "title-pixels-long": "status",
  "title-pixels-short": "status",
  "meta-pixels-long": "status",
  "meta-pixels-short": "status",
  "readability-difficult": "status",
  "readability-very-difficult": "status",

  "nofollow-directive": "head",
  "meta-short": "head",

  "title-equals-h1": "dom",
  "h1-duplicate": "dom",
  "h1-long": "dom",

  "h2-duplicate": "text",
  "h2-long": "text",
  "h2-multiple": "text",
  "no-internal-outlinks": "text",
};

const CONTENT_RULES = new Set([
  "title-missing", "title-long", "title-short", "title-duplicate",
  "meta-missing", "meta-long", "meta-short", "meta-duplicate",
  "h1-missing", "h1-multiple", "h1-duplicate", "h1-long",
  "h2-missing", "h2-multiple", "h2-duplicate", "h2-long",
  "canonical-missing", "canonical-noindex-conflict", "canonicalised",
  "noindex-with-inlinks", "blocked-with-inlinks", "nofollow-directive", "thin-content",
]);

const CRAWL_ONLY_RULES = new Set([
  "orphan-in-crawl", "deep-page", "url-contains-space", "url-non-ascii", "url-too-long",
  "title-pixels-long", "title-pixels-short", "meta-pixels-long", "meta-pixels-short",
  "readability-difficult", "readability-very-difficult", "title-duplicate", "meta-duplicate",
  "h1-duplicate", "h2-duplicate", "canonical-to-non-200",
]);

/** H2 text content, recovered by regex the same way the h2-missing check reads the document. */
function h2Texts(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
}

const CAP_RANK: Record<Capability, number> = { status: 0, head: 1, dom: 2, text: 3 };

/** Unknown rules fall back to "status": the default classify branch only reads the status code. */
function capabilityFor(checks: VerifyCheck[], collectLinks: boolean): Capability {
  let cap: Capability = "status";
  for (const c of checks) {
    const need = RULE_CAPS[c.ruleId] ?? "status";
    if (CAP_RANK[need] > CAP_RANK[cap]) cap = need;
  }
  // Link harvesting needs every <a href> in the document, so it forces a full parse.
  if (collectLinks && CAP_RANK[cap] < CAP_RANK.dom) cap = "dom";
  return cap;
}

/* -------------------------------------------------------------------------- */
/* Caches — bounded, so a warm instance cannot leak into an OOM                 */
/* -------------------------------------------------------------------------- */

const ROBOTS_TTL_MS = 10 * 60_000;
const ROBOTS_MAX_ORIGINS = 200;
const robotsCache = new Map<string, { groups: RobotsGroup[]; fetchedAt: number }>();

function cacheRobots(origin: string, groups: RobotsGroup[]): void {
  // Map preserves insertion order, so the first key is the oldest entry.
  if (robotsCache.size >= ROBOTS_MAX_ORIGINS) {
    const oldest = robotsCache.keys().next().value;
    if (oldest !== undefined) robotsCache.delete(oldest);
  }
  robotsCache.set(origin, { groups, fetchedAt: Date.now() });
}

/**
 * Per-instance rate limit. Under Fluid this is advisory — each instance keeps
 * its own bucket, so the real ceiling is enforced client-side by the CPU
 * governor. It exists to blunt a single runaway tab, not to be authoritative.
 *
 * The default of 60/min sits just under what the client's own 3-concurrent
 * batching produces (~69/min), so a healthy run spends half its life bouncing
 * off its own limiter and backing off. Raise it — or set VERIFY_RATE_LIMIT=0 to
 * disable it entirely, which is the right setting for a local run where the
 * only client is you.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = (() => {
  const raw = process.env.VERIFY_RATE_LIMIT;
  if (raw === undefined) return 600;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 600;
})();
const rateBucket = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  if (RATE_MAX_REQUESTS <= 0) return false; // explicitly disabled
  const now = Date.now();
  // Evict stale windows every call: cheap, and stops unbounded growth.
  if (rateBucket.size > 500) {
    for (const [key, b] of rateBucket) {
      if (now - b.windowStart > RATE_WINDOW_MS) rateBucket.delete(key);
    }
  }
  const bucket = rateBucket.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBucket.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_MAX_REQUESTS;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                     */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        // Ask for a compressed body: less to decode, less CPU, less transfer.
        "Accept-Encoding": "gzip, deflate, br",
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getRobots(origin: string): Promise<RobotsGroup[]> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.groups;
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    const groups = res.ok ? parseRobotsTxt(await res.text()) : [];
    cacheRobots(origin, groups);
    return groups;
  } catch {
    cacheRobots(origin, []);
    return [];
  }
}

/**
 * Reads only as much of the body as the caller needs.
 *
 * `res.text()` always buffers and decodes the whole response. For a "head" tier
 * page we stop the moment `</head>` appears, which on a typical marketing page
 * means decoding ~8 KB instead of ~800 KB. For "status" we cancel the stream
 * without decoding a single byte.
 */
async function readBody(res: Response, cap: Capability): Promise<string> {
  if (cap === "status" || !res.body) {
    // Releasing the stream lets undici reclaim the socket without buffering.
    try {
      await res.body?.cancel();
    } catch {
      /* already consumed or closed */
    }
    return "";
  }

  const limit = cap === "head" ? MAX_HEAD_BYTES : MAX_HTML_BYTES;
  const reader = res.body.getReader();
  const charset = res.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  let out = "";
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (cap === "head" && /<\/head\s*>/i.test(out)) break;
      if (bytes >= limit) break;
    }
  } catch {
    /* truncated body is still usable */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
  return out;
}

export interface LiveState {
  finalUrl: string;
  finalStatus: number;
  chain: string[];
  /** Repeated canonical URL was observed in the live redirect chain. */
  redirectLoopDetected: boolean;
  /** More redirects existed than the verifier was willing to follow. */
  hopLimitHit: boolean;
  html: string;
  headers: Headers;
  cap: Capability;
  title: string;
  metaDescription: string;
  metaRobots: string;
  metaRobotsTag: string;
  canonical: string;
  canonicalRawLine: string;
  h1s: string[];
  mixedContentCount: number;
  hasJsonLd: boolean;
  internalLinks: LiveLink[];
  responseMs: number;
}

function emptyExtraction(): Pick<
  LiveState,
  | "title"
  | "metaDescription"
  | "metaRobots"
  | "metaRobotsTag"
  | "canonical"
  | "canonicalRawLine"
  | "h1s"
  | "mixedContentCount"
  | "hasJsonLd"
  | "internalLinks"
> {
  return {
    title: "",
    metaDescription: "",
    metaRobots: "",
    metaRobotsTag: "",
    canonical: "",
    canonicalRawLine: "",
    h1s: [],
    mixedContentCount: 0,
    hasJsonLd: false,
    internalLinks: [],
  };
}

/** Landmark ancestors, most specific first, mapped to the SF position vocabulary. */
const LANDMARKS: { selector: (el: HTMLElement) => boolean; position: LinkPosition }[] = [
  { selector: (el) => el.rawTagName?.toLowerCase() === "nav", position: "Navigation" },
  { selector: (el) => el.rawTagName?.toLowerCase() === "footer", position: "Footer" },
  { selector: (el) => el.rawTagName?.toLowerCase() === "header", position: "Header" },
  { selector: (el) => el.rawTagName?.toLowerCase() === "aside", position: "Aside" },
  { selector: (el) => el.rawTagName?.toLowerCase() === "main", position: "Content" },
  { selector: (el) => el.rawTagName?.toLowerCase() === "article", position: "Content" },
];

/**
 * Where in the page this element sits.
 *
 * Walks up to the nearest landmark, checking ARIA roles and the usual class/id
 * conventions on the way, because plenty of real templates use `<div id="footer">`
 * rather than `<footer>`. Mirrors Screaming Frog's Link Position vocabulary so
 * crawl-sourced and live-sourced links can be counted together.
 */
function linkPositionOf(el: HTMLElement): LinkPosition {
  let node: HTMLElement | null = el;
  let depth = 0;
  while (node && depth < 30) {
    // Head elements (canonical, hreflang alternates) have no page area. Letting
    // them fall through to the Content default would inflate the Content bucket
    // in the fix-by-template view, which is meant to mean "someone has to go
    // edit a page", not "a tag in the document head".
    if (node.rawTagName?.toLowerCase() === "head") return "Unknown";
    const role = node.getAttribute?.("role")?.toLowerCase() ?? "";
    if (role === "navigation") return "Navigation";
    if (role === "contentinfo") return "Footer";
    if (role === "banner") return "Header";
    if (role === "complementary") return "Aside";
    if (role === "main") return "Content";

    for (const l of LANDMARKS) {
      if (l.selector(node)) return l.position;
    }

    const hint = `${node.getAttribute?.("id") ?? ""} ${node.getAttribute?.("class") ?? ""}`.toLowerCase();
    if (/\b(nav|navbar|menu|topnav|mainnav)\b/.test(hint)) return "Navigation";
    if (/\b(footer|site-footer|colophon)\b/.test(hint)) return "Footer";
    if (/\b(header|masthead|site-header)\b/.test(hint)) return "Header";
    if (/\b(sidebar|widget-area)\b/.test(hint)) return "Sidebar";

    node = node.parentNode as HTMLElement | null;
    depth++;
  }
  return "Content";
}

/** Every element type that can point at a URL, with the SF type name for each. */
const LINK_SOURCES: { selector: string; attr: string; type: string }[] = [
  { selector: "a[href]", attr: "href", type: "Hyperlink" },
  { selector: "img[src]", attr: "src", type: "Image" },
  { selector: "iframe[src]", attr: "src", type: "Iframe" },
  { selector: 'link[rel="canonical"]', attr: "href", type: "Canonical" },
  { selector: "link[hreflang]", attr: "href", type: "Hreflang" },
  { selector: "form[action]", attr: "action", type: "Form Action" },
  { selector: "source[src]", attr: "src", type: "Media" },
];

/**
 * Harvest same-origin links from a parsed page, WITH their source-code context.
 *
 * This is the only point in the pipeline where the *linking* page is in hand —
 * /api/verify otherwise fetches the broken URL itself, which can prove a URL is
 * still 404 but can never show where the link to it lives. Returning bare URL
 * strings (the previous behaviour) threw that away at the one moment it was free.
 *
 * The widened selector list matters as much as the snippet: broken images,
 * canonicals pointing at dead URLs and hreflang alternates are exactly the edges
 * a hyperlink-only harvest misses, and they are the ones users report as "a 404
 * with no source".
 */
function extractLinks(root: HTMLElement, currentUrl: string): LiveLink[] {
  const links: LiveLink[] = [];
  const seen = new Set<string>();
  const pageOrigin = new URL(currentUrl).origin;

  for (const src of LINK_SOURCES) {
    for (const el of root.querySelectorAll(src.selector)) {
      if (links.length >= MAX_LINKS_PER_PAGE) return links;
      const raw = el.getAttribute(src.attr);
      if (!raw || raw.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
      try {
        const abs = new URL(raw, currentUrl);
        abs.hash = "";
        const str = abs.toString();
        // Concatenated blobs (broken href markup) have their own detection rule —
        // chasing them via link jump would re-create the giant-URL findings this
        // pipeline is meant to keep readable.
        if (isConcatenatedUrl(str)) continue;
        if (abs.origin !== pageOrigin) continue;
        const key = `${src.type}|${str}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rel = el.getAttribute("rel") ?? undefined;
        links.push({
          url: str,
          anchor: (el.text ?? "").trim().slice(0, 120) || (el.getAttribute("alt") ?? "").trim().slice(0, 120),
          // Truncated: a ticket needs the tag, not the subtree under it.
          snippet: (el.outerHTML ?? "").replace(/\s+/g, " ").slice(0, 300),
          position: linkPositionOf(el),
          linkType: src.type,
          rel,
          follow: rel ? !/\bnofollow\b/i.test(rel) : undefined,
        });
      } catch {
        /* malformed href */
      }
    }
  }
  return links;
}

/**
 * One fetch, one parse, everything the page's rules need.
 *
 * Redirect handling stops on an observed repeated URL or at a bounded hop limit.
 * A long chain is not assumed to be a loop.
 */
async function fetchLive(url: string, cap: Capability, collectLinks: boolean): Promise<LiveState> {
  const attempt = async (timeoutMs: number): Promise<LiveState> => {
    const chain: string[] = [];
    let current = url;
    let res: Response | null = null;
    let redirectLoopDetected = false;
    let hopLimitHit = false;
    let responseMs = 0;
    const redirectKey = (value: string) => {
      const parsed = new URL(value);
      parsed.hash = "";
      return parsed.href;
    };
    const visited = new Set([redirectKey(url)]);

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const requestStarted = Date.now();
      res = await fetchWithTimeout(current, timeoutMs);
      responseMs = Date.now() - requestStarted;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        let next: string;
        try {
          next = new URL(loc, current).toString();
        } catch {
          break; // unparseable Location — treat the redirect as terminal
        }
        chain.push(`${res.status} → ${next}`);
        await res.body?.cancel().catch(() => undefined);
        if (visited.has(redirectKey(next))) {
          redirectLoopDetected = true;
          current = next;
          break;
        }
        if (hop === MAX_HOPS) {
          hopLimitHit = true;
          break;
        }
        visited.add(redirectKey(next));
        current = next;
        continue;
      }
      break;
    }
    if (!res) throw new Error("No response");

    const contentType = res.headers.get("content-type") ?? "";
    const isMarkup = /html|xml/i.test(contentType);
    // Non-markup responses (PDF, image, JSON) have nothing our rules can read.
    const effectiveCap: Capability = isMarkup && !hopLimitHit ? cap : "status";
    const html = await readBody(res, effectiveCap);

    const base: LiveState = {
      finalUrl: current,
      finalStatus: res.status,
      chain,
      redirectLoopDetected,
      hopLimitHit,
      html,
      headers: res.headers,
      cap: effectiveCap,
      responseMs,
      ...emptyExtraction(),
    };

    if (effectiveCap === "status" || html === "") return base;

    const root = parseHtml(html, {
      // Skip tag bodies we never read. On script-heavy pages this alone cuts
      // parse time roughly in half.
      blockTextElements: { script: false, noscript: false, style: false, pre: true },
    });

    base.title = root.querySelector("title")?.text.trim() ?? "";
    base.metaDescription =
      root.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim() ?? "";
    base.metaRobotsTag = root.querySelector('meta[name="robots" i]')?.getAttribute("content") ?? "";
    base.metaRobots = [base.metaRobotsTag, res.headers.get("x-robots-tag") ?? ""].filter(Boolean).join(", ");
    base.canonical = root.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() ?? "";
    base.canonicalRawLine = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? "";
    base.hasJsonLd = root.querySelectorAll('script[type="application/ld+json"]').length > 0;

    if (CAP_RANK[effectiveCap] >= CAP_RANK.dom) {
      base.h1s = root.querySelectorAll("h1").map((h) => h.text.trim());
      // Full-document regexes only run when we already hold the full document.
      base.mixedContentCount = current.startsWith("https://")
        ? (html.match(/(?:src|href)=["']http:\/\//gi) ?? []).length
        : 0;
      if (collectLinks) base.internalLinks = extractLinks(root, current);
    }

    return base;
  };

  try {
    return await attempt(FETCH_TIMEOUT_MS);
  } catch (first) {
    // One retry, on a shorter leash. A URL that already timed out at 10s is
    // unlikely to answer on the second try, and 20s of held instance is
    // Provisioned Memory we are paying for.
    try {
      return await attempt(RETRY_TIMEOUT_MS);
    } catch {
      throw first instanceof Error ? first : new Error("Fetch failed");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Module J — header audit, free on a fetch we already made                     */
/* -------------------------------------------------------------------------- */

function auditHeaders(url: string, headers: Headers, metaRobots: string): HeaderFinding[] {
  const findings: HeaderFinding[] = [];
  const get = (k: string) => headers.get(k) ?? "";
  const isHttps = url.startsWith("https://");

  if (isHttps) {
    findings.push(
      get("strict-transport-security")
        ? { url, check: "HSTS", grade: "pass", detail: get("strict-transport-security") }
        : { url, check: "HSTS", grade: "warn", detail: "No Strict-Transport-Security header" }
    );
  }
  const csp = get("content-security-policy");
  findings.push(
    csp
      ? { url, check: "Content-Security-Policy", grade: "pass", detail: csp }
      : { url, check: "Content-Security-Policy", grade: "warn", detail: "No Content-Security-Policy header" }
  );
  findings.push(
    /\bnosniff\b/i.test(get("x-content-type-options"))
      ? { url, check: "X-Content-Type-Options", grade: "pass", detail: get("x-content-type-options") }
      : { url, check: "X-Content-Type-Options", grade: "warn", detail: "Missing nosniff directive" }
  );
  const framePolicy = get("x-frame-options");
  findings.push(
    framePolicy || /frame-ancestors\s+[^;]+/i.test(csp)
      ? { url, check: "Clickjacking protection", grade: "pass", detail: framePolicy || csp.match(/frame-ancestors\s+[^;]+/i)?.[0] || "CSP frame-ancestors" }
      : { url, check: "Clickjacking protection", grade: "warn", detail: "No X-Frame-Options or CSP frame-ancestors policy" }
  );
  const referrerPolicy = get("referrer-policy");
  findings.push(
    /^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/i.test(referrerPolicy)
      ? { url, check: "Referrer-Policy", grade: "pass", detail: referrerPolicy }
      : { url, check: "Referrer-Policy", grade: "warn", detail: referrerPolicy || "No Referrer-Policy header" }
  );
  const xRobots = get("x-robots-tag");
  if (xRobots) {
    const headerNoindex = /noindex/i.test(xRobots);
    const metaNoindex = /noindex/i.test(metaRobots);
    if (headerNoindex !== metaNoindex && (metaRobots || headerNoindex)) {
      findings.push({
        url,
        check: "X-Robots-Tag vs meta robots",
        grade: "fail",
        detail: `Header "${xRobots}" conflicts with meta robots "${metaRobots || "(absent)"}" — header-level directives silently win.`,
      });
    } else {
      findings.push({ url, check: "X-Robots-Tag", grade: "pass", detail: xRobots });
    }
  }
  const enc = get("content-encoding");
  findings.push(
    /br|gzip|zstd/.test(enc)
      ? { url, check: "Compression", grade: "pass", detail: enc }
      : { url, check: "Compression", grade: "warn", detail: "Response not compressed (no br/gzip)" }
  );
  const cache = get("cache-control");
  if (!cache) findings.push({ url, check: "Cache-Control", grade: "warn", detail: "No Cache-Control header" });
  const ct = get("content-type");
  if (ct && !/charset/i.test(ct) && /text\/html/i.test(ct))
    findings.push({ url, check: "Content-Type charset", grade: "warn", detail: `"${ct}" declares no charset` });
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Classification — unchanged semantics, one live state per page                */
/* -------------------------------------------------------------------------- */

function classify(
  ruleId: string,
  crawlEvidence: string,
  live: LiveState
): { status: "CONFIRMED" | "RESOLVED" | "UNVERIFIABLE"; liveEvidence: string } {
  const confirmed = (ev: string) => ({ status: "CONFIRMED" as const, liveEvidence: ev });
  const resolved = (ev: string) => ({ status: "RESOLVED" as const, liveEvidence: ev });
  const unverifiable = (ev: string) => ({ status: "UNVERIFIABLE" as const, liveEvidence: ev });
  const s = live.finalStatus;
  const redirected = live.chain.length > 0;

  if ([401, 403, 429].includes(s) || live.headers.has("cf-mitigated")) {
    return unverifiable(`Live fetch was blocked or rate-limited (HTTP ${s}); verify from an authorized crawl environment.`);
  }
  if (/captcha|verify you are human|checking your browser|bot detection|access denied/i.test(live.html)) {
    return unverifiable("Live response appears to be a bot challenge; no SEO verdict was inferred.");
  }
  if (CONTENT_RULES.has(ruleId)) {
    const contentType = live.headers.get("content-type") ?? "";
    if (s !== 200 || !/text\/html|application\/xhtml\+xml/i.test(contentType) || !live.html) {
      return unverifiable(`Live response was HTTP ${s} with content type "${contentType || "unknown"}", not a readable HTML page.`);
    }
  }
  if (CRAWL_ONLY_RULES.has(ruleId)) {
    return unverifiable("This finding depends on crawl-wide or Screaming Frog-only data and cannot be independently re-measured from one live fetch.");
  }

  switch (ruleId) {
    case "full-site-url-check": {
      const crawlStatus = Number.parseInt(crawlEvidence.match(/HTTP\s+(\d{3})/i)?.[1] ?? "0", 10);
      const redirectNote = redirected ? `; redirect chain: ${live.chain.join(" | ")}` : "";
      return confirmed(`Live HTTP ${s}; crawl HTTP ${crawlStatus}${redirectNote}`);
    }
    case "http-4xx":
      return s >= 400 && s < 500
        ? confirmed(`Live fetch: HTTP ${s}`)
        : resolved(`Live fetch now returns ${s}${redirected ? ` via ${live.chain.join(" ")}` : ""}`);
    case "http-5xx":
      return s >= 500 ? confirmed(`Live fetch: HTTP ${s}`) : resolved(`Live fetch now returns ${s}`);
    case "redirect-302": {
      const first = live.chain[0] ?? "";
      if (first.startsWith("302") || first.startsWith("307")) return confirmed(`Live: ${first}`);
      return resolved(redirected ? `Live: ${live.chain.join(" ")}` : `No longer redirects (HTTP ${s})`);
    }
    case "redirect-chain":
      return live.chain.length >= 2
        ? confirmed(`Live chain (${live.chain.length} hops): ${live.chain.join(" ")}`)
        : resolved(redirected ? `Single hop now: ${live.chain[0]}` : `No longer redirects (HTTP ${s})`);
    case "redirect-loop":
      return live.redirectLoopDetected
        ? confirmed(`Still chaining past ${MAX_HOPS} hops: ${live.chain.slice(0, 3).join(" ")}…`)
        : live.hopLimitHit
          ? unverifiable(`Redirect chain exceeded ${MAX_HOPS} hops without repeating a URL.`)
        : resolved(`Chain now resolves: ${live.chain.join(" ") || `HTTP ${s}`}`);
    case "redirect-broken-target":
      return redirected && s >= 400
        ? confirmed(`Live: ${live.chain.join(" ")} → final HTTP ${s}`)
        : resolved(`Final destination now returns ${s}`);
    case "title-missing":
      return live.title === ""
        ? confirmed("Live source: no <title> content")
        : resolved(`Live <title>: "${live.title.slice(0, 90)}"`);
    case "title-long":
      return live.title.length > 60
        ? confirmed(`Live title, ${live.title.length} chars: "${live.title.slice(0, 90)}"`)
        : resolved(`Live title now ${live.title.length} chars`);
    case "title-short":
      return live.title.length > 0 && live.title.length < 30
        ? confirmed(`Live title, ${live.title.length} chars: "${live.title}"`)
        : resolved(`Live title now ${live.title.length} chars`);
    case "title-duplicate":
      return crawlEvidence.includes(live.title) && live.title !== ""
        ? confirmed(`Live title unchanged: "${live.title.slice(0, 90)}"`)
        : resolved(`Live title changed to: "${live.title.slice(0, 90)}"`);
    case "meta-missing":
      return live.metaDescription === ""
        ? confirmed("Live source: no meta description")
        : resolved(`Live meta description present (${live.metaDescription.length} chars)`);
    case "meta-long":
      return live.metaDescription.length > 155
        ? confirmed(`Live meta description ${live.metaDescription.length} chars`)
        : resolved(`Now ${live.metaDescription.length} chars`);
    case "meta-duplicate":
      return crawlEvidence.includes(live.metaDescription.slice(0, 60)) && live.metaDescription !== ""
        ? confirmed(`Live meta description unchanged`)
        : resolved("Live meta description changed");
    case "h1-missing":
      return live.h1s.length === 0
        ? confirmed("Live source: no <h1> element")
        : resolved(`Live H1: "${live.h1s[0]?.slice(0, 90)}"`);
    case "h1-multiple":
      return live.h1s.length > 1
        ? confirmed(
            `Live source has ${live.h1s.length} H1s: ${live.h1s.slice(0, 2).map((h) => `"${h.slice(0, 50)}"`).join(", ")}`
          )
        : resolved(`Live source has ${live.h1s.length} H1`);
    case "h2-missing":
      return !/<h2[\s>]/i.test(live.html)
        ? confirmed("Live source: no <h2> elements")
        : resolved("Live source now contains H2s");
    case "canonical-missing":
      return live.canonical === ""
        ? confirmed('Live source: no <link rel="canonical">')
        : resolved(`Live: ${live.canonicalRawLine || live.canonical}`);
    case "canonical-noindex-conflict": {
      const stillNoindex = /noindex/i.test(live.metaRobots);
      const stillCanonicalized =
        live.canonical !== "" && live.canonical.replace(/\/$/, "") !== live.finalUrl.replace(/\/$/, "");
      return stillNoindex && stillCanonicalized
        ? confirmed(`Live: ${live.canonicalRawLine} + <meta name="robots" content="${live.metaRobots}">`)
        : resolved(`Live signals: canonical="${live.canonical}", robots="${live.metaRobots || "(none)"}"`);
    }
    case "canonical-to-non-200":
      return unverifiable("The canonical target's current status is not available from this page fetch.");
    case "canonicalised":
      return live.canonical !== "" && live.canonical.replace(/\/$/, "") !== live.finalUrl.replace(/\/$/, "")
        ? confirmed(`Live: ${live.canonicalRawLine || `canonical → ${live.canonical}`}`)
        : resolved(`Live canonical: "${live.canonical || "(absent)"}"`);
    case "noindex-with-inlinks":
    case "blocked-with-inlinks":
      return /noindex/i.test(live.metaRobots)
        ? confirmed(`Live: <meta name="robots" content="${live.metaRobots}">`)
        : resolved(`Live meta robots: "${live.metaRobots || "(none)"}"`);
    case "slow-response":
      return live.responseMs > 1000
        ? confirmed(`Live fetch took ${(live.responseMs / 1000).toFixed(2)}s`)
        : resolved(`Live fetch took ${(live.responseMs / 1000).toFixed(2)}s`);
    case "thin-content": {
      const root = parseHtml(live.html);
      for (const selector of ["script", "style", "nav", "header", "footer", "aside", "noscript", "template"]) {
        for (const el of root.querySelectorAll(selector)) el.remove();
      }
      const main = root.querySelector("main, article, [role=main]") ?? root.querySelector("body") ?? root;
      const text = main.text.replace(/\s+/g, " ");
      const words = text.split(/\s+/).filter(Boolean).length;
      return words < 150 ? confirmed(`Live body ≈ ${words} words`) : resolved(`Live body ≈ ${words} words`);
    }
    case "malformed-concatenated-url":
      // The defect is the address itself, not the response — a 200 (soft
      // resolve) doesn't fix the broken href that produced this blob.
      return confirmed(
        `Live fetch of the concatenated address: HTTP ${s}. The address is malformed regardless of the response — locate the page(s) emitting this broken href (see error sources) and fix the markup.`
      );
    case "no-response":
      return resolved(`Live fetch answered with HTTP ${s} — the URL responds now`);
    case "nofollow-directive":
      return /\bnofollow\b/i.test(live.metaRobots)
        ? confirmed(`Live: <meta name="robots" content="${live.metaRobots}">`)
        : resolved(`Live meta robots: "${live.metaRobots || "(none)"}"`);
    case "meta-short":
      return live.metaDescription.length > 0 && live.metaDescription.length < 70
        ? confirmed(`Live meta description ${live.metaDescription.length} chars`)
        : resolved(`Live meta description now ${live.metaDescription.length} chars`);
    case "title-equals-h1": {
      const h1 = live.h1s[0]?.trim() ?? "";
      return h1 !== "" && h1 === live.title.trim()
        ? confirmed(`Live title and H1 both read "${h1.slice(0, 80)}"`)
        : resolved(`Live title "${live.title.slice(0, 60)}" vs H1 "${h1.slice(0, 60)}"`);
    }
    case "h1-long": {
      const h1 = live.h1s[0] ?? "";
      return h1.length > 70
        ? confirmed(`Live H1, ${h1.length} chars: "${h1.slice(0, 90)}"`)
        : resolved(`Live H1 now ${h1.length} chars`);
    }
    case "h1-duplicate": {
      const h1 = live.h1s[0] ?? "";
      return h1 !== "" && crawlEvidence.includes(h1.slice(0, 60))
        ? confirmed(`Live H1 unchanged: "${h1.slice(0, 90)}"`)
        : resolved(`Live H1 changed to: "${h1.slice(0, 90)}"`);
    }
    case "h2-long": {
      const longest = h2Texts(live.html).reduce((a, b) => (b.length > a.length ? b : a), "");
      return longest.length > 70
        ? confirmed(`Live H2, ${longest.length} chars: "${longest.slice(0, 90)}"`)
        : resolved(`Longest live H2 now ${longest.length} chars`);
    }
    case "h2-duplicate": {
      const first = h2Texts(live.html)[0] ?? "";
      return first !== "" && crawlEvidence.includes(first.slice(0, 60))
        ? confirmed(`Live H2 unchanged: "${first.slice(0, 90)}"`)
        : resolved(`Live H2 changed to: "${first.slice(0, 90)}"`);
    }
    case "h2-multiple": {
      const all = h2Texts(live.html);
      return all.length > 1
        ? confirmed(`Live source has ${all.length} H2s: ${all.slice(0, 2).map((h) => `"${h.slice(0, 45)}"`).join(", ")}`)
        : resolved(`Live source has ${all.length} H2`);
    }
    case "no-internal-outlinks": {
      const hrefs = [...live.html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
      const internal = hrefs.filter(
        (h) => !/^(https?:)?\/\//i.test(h) || h.includes(new URL(live.finalUrl).host)
      ).filter((h) => !/^(#|mailto:|tel:|javascript:|data:)/i.test(h));
      return internal.length === 0
        ? confirmed("Live source contains no internal links — still a dead end")
        : resolved(`Live source now has ${internal.length} internal link(s)`);
    }
    case "oversized-resource": {
      const len = parseInt(live.headers.get("content-length") ?? "", 10);
      if (!Number.isFinite(len)) return unverifiable(`No Content-Length on the live response; crawl measured: ${crawlEvidence}`);
      if (live.headers.has("content-encoding") && len <= 2 * 1024 * 1024) {
        return unverifiable("The live Content-Length is compressed transfer size, so it cannot confirm the uncompressed resource size.");
      }
      return len > 2 * 1024 * 1024
        ? confirmed(`Live Content-Length ${(len / 1024 / 1024).toFixed(2)}MB`)
        : resolved(`Live Content-Length now ${(len / 1024 / 1024).toFixed(2)}MB`);
    }
    case "link-jump-check":
      return s >= 400
        ? confirmed(`Live fetch: HTTP ${s} — this URL was discovered in another page's live source, not in the crawl`)
        : resolved(`Live fetch: HTTP ${s}${redirected ? ` via ${live.chain.join(" ")}` : ""}`);
    default:
      return unverifiable(`No live verification adapter exists for this finding (current HTTP ${s}).`);
  }
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                      */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  const readMeter = startMeter();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded. Slow down and retry." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = VerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request: " + parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }
  const { pages, delayMs, collectLinks, collectHeaders } = parsed.data;

  const results: VerifyResultItem[] = [];
  const counters = { cacheHits: 0, bodySkipped: 0, headOnly: 0 };

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageCollectLinks = collectLinks || page.collectLinks === true;
    const cap = capabilityFor(page.checks, pageCollectLinks);

    try {
      const parsedUrl = new URL(page.url);
      const robots = await getRobots(parsedUrl.origin);
      const verdict = checkRobots(robots, parsedUrl.pathname + parsedUrl.search);

      if (!verdict.allowed) {
        for (const check of page.checks) {
          results.push({
            issueId: check.issueId,
            status: "UNVERIFIABLE",
            liveEvidence: "",
            verifyError: `Blocked by robots.txt (${verdict.matchedRule}) — AuditForge respects crawl directives.`,
          });
        }
        continue;
      }

      // ── One fetch. One parse. Every rule on this URL classified from it. ──
      const live = await fetchLive(page.url, cap, pageCollectLinks);
      if (live.cap === "status") counters.bodySkipped++;
      else if (live.cap === "head") counters.headOnly++;

      const headerFindings = collectHeaders ? auditHeaders(page.url, live.headers, live.metaRobotsTag) : undefined;

      for (const [idx, check] of page.checks.entries()) {
        const { status, liveEvidence } = classify(check.ruleId, check.crawlEvidence, live);
        results.push({
          issueId: check.issueId,
          status,
          liveEvidence,
          finalStatusCode: live.finalStatus,
          redirectChain: live.chain,
          // Page-level payloads ride on the first check only: repeating them
          // per issue is pure JSON serialisation cost, and the client keys
          // them by URL anyway.
          headerFindings: idx === 0 ? headerFindings : undefined,
          mixedContentCount: idx === 0 ? live.mixedContentCount : undefined,
          hasJsonLd: idx === 0 ? live.hasJsonLd : undefined,
          internalLinks: idx === 0 && live.internalLinks.length > 0 ? live.internalLinks : undefined,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Fetch failed";
      for (const check of page.checks) {
        results.push(
          check.ruleId === "no-response"
            ? { issueId: check.issueId, status: "CONFIRMED", liveEvidence: `No HTTP response after retry: ${message}` }
            : { issueId: check.issueId, status: "UNVERIFIABLE", liveEvidence: "", verifyError: message }
        );
      }
    }

    if (p < pages.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const reading = readMeter();
  const meter: VerifyMeter = { ...reading, ...counters };
  return NextResponse.json({ results, meter });
}