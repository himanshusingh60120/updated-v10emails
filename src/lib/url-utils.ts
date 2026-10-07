/**
 * Utilities for spotting and dissecting malformed "concatenated" URLs — single
 * crawled addresses that actually contain several URLs mashed together, the
 * classic symptom of a broken <a href> in page markup (missing quote, template
 * bug, or copy-paste error). Screaming Frog crawls the whole blob as one
 * Address, it 404s, and without this handling the report shows one giant
 * unreadable cell instead of a precise finding.
 *
 * A second `https?://` inside a URL is only treated as malformed when it sits
 * in path context. URLs passed as query-param values (`?url=https://…`,
 * `&next=https://…`, `?https://…`) are legitimate and left alone.
 */

const SCHEME_RE = /https?:\/\//gi;

/** Positions (index > 0) where another scheme starts in *path* context. */
function embeddedSchemeCuts(url: string): number[] {
  const cuts: number[] = [];
  SCHEME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCHEME_RE.exec(url))) {
    if (m.index === 0) continue;
    const prev = url[m.index - 1];
    if (prev === "=" || prev === "?" || prev === "&") continue; // query-param value — legitimate
    cuts.push(m.index);
  }
  return cuts;
}

/** True when the address contains multiple URLs concatenated together. */
export function isConcatenatedUrl(url: string): boolean {
  return embeddedSchemeCuts(url).length > 0;
}

/**
 * Split a concatenated address into its constituent URLs.
 * Returns `[url]` unchanged when the address is clean.
 * Trailing separator junk (`%20`, whitespace, stray `:` / `,` / `;`) left at
 * the seam between two URLs is trimmed from each piece.
 */
export function splitConcatenatedUrls(url: string): string[] {
  const cuts = embeddedSchemeCuts(url);
  if (cuts.length === 0) return [url];
  const parts: string[] = [];
  let start = 0;
  for (const cut of [...cuts, url.length]) {
    const piece = url
      .slice(start, cut)
      .replace(/(?:%20|\s)+$/gi, "")
      .replace(/[,;:]+$/g, "");
    if (piece) parts.push(piece);
    start = cut;
  }
  return parts.length > 1 ? parts : [url];
}

/* -------------------------------------------------------------------------- */
/* Canonical URL normalization                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One normalizer for the whole codebase.
 *
 * Before this existed there were four inline `u.replace(/\/$/, "")` helpers
 * (sources.ts, page.tsx link-jump, modules.ts diffSitemap, detect.ts byUrl) and
 * they disagreed with each other. Every disagreement is a silent miss: an issue
 * renders with no sources, and that looks identical to a URL nothing links to.
 *
 * Folding is deliberately conservative. Host case and default ports are always
 * safe. Path case is NOT folded by default — plenty of sites serve different
 * content at /Foo and /foo — but it is offered as an opt-in for the second
 * matching pass, where a near-miss is better reported than dropped.
 */
export interface CanonicalizeOptions {
  /** Drop a single trailing slash from the path. Default true. */
  foldTrailingSlash?: boolean;
  /** Treat www.example.com and example.com as the same host. Default true. */
  foldWww?: boolean;
  /** Treat http:// and https:// as the same. Default true. */
  foldProtocol?: boolean;
  /** Lowercase the path too. Default false — opt-in for the fuzzy pass. */
  foldPathCase?: boolean;
  /** Sort query parameters so ?a=1&b=2 matches ?b=2&a=1. Default true. */
  sortQuery?: boolean;
  /** Drop the query string entirely. Default false. */
  dropQuery?: boolean;
}

const DEFAULTS: Required<CanonicalizeOptions> = {
  foldTrailingSlash: true,
  foldWww: true,
  foldProtocol: true,
  foldPathCase: false,
  sortQuery: true,
  dropQuery: false,
};

/**
 * Normalize a URL into a comparison key. Never throws: an unparseable address
 * falls back to a trimmed, lowercased version of the raw string so that even
 * malformed inputs still group with themselves.
 */
export function canonicalizeUrl(raw: string, opts: CanonicalizeOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const input = (raw ?? "").trim();
  if (!input) return "";
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input.toLowerCase().replace(/\/+$/, "");
  }

  // Scheme + host: always safe to lowercase; the URL constructor already does.
  let scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (o.foldProtocol && (scheme === "http" || scheme === "https")) scheme = "https";

  let host = u.hostname.toLowerCase();
  if (o.foldWww) host = host.replace(/^www\./, "");
  // Default ports carry no meaning and appear inconsistently across exports.
  const port = (scheme === "https" && u.port === "443") || (scheme === "http" && u.port === "80") ? "" : u.port;

  // Path: re-encode consistently. `new URL` already resolves dot-segments and
  // normalizes most percent-encoding; decode/re-encode settles the rest
  // (%7E vs ~, + vs %20 in the path) without changing meaning.
  let path = u.pathname;
  try {
    path = decodeURIComponent(path)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  } catch {
    /* invalid escape sequence — keep the raw path */
  }
  if (o.foldPathCase) path = path.toLowerCase();
  if (o.foldTrailingSlash && path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  // Query: an empty "?" is noise. Sorting makes parameter order irrelevant.
  let query = "";
  if (!o.dropQuery && u.searchParams.toString() !== "") {
    if (o.sortQuery) {
      const pairs = [...u.searchParams.entries()].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
      );
      query = "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    } else {
      query = "?" + u.searchParams.toString();
    }
  }

  // Fragments never reach the server, so they can never distinguish two URLs.
  return `${scheme}://${host}${port ? `:${port}` : ""}${path}${query}`;
}

/** How a lookup in a {@link UrlIndex} was satisfied. Reported, never guessed at. */
export type UrlMatch = "exact" | "canonical" | "fuzzy" | "miss";

export interface UrlLookup<T> {
  value: T | undefined;
  match: UrlMatch;
}

/**
 * A Map keyed on URLs that tolerates the formatting drift between a Screaming
 * Frog export, a sitemap, GSC, and live HTML — while still telling you which
 * pass matched, so "we found it loosely" is never presented as "exact".
 *
 * Three passes, strictest first:
 *   exact     — byte-identical string
 *   canonical — same after {@link canonicalizeUrl} with safe folding
 *   fuzzy     — same after additionally folding path case
 */
export class UrlIndex<T> {
  private exact = new Map<string, T>();
  private canonical = new Map<string, T>();
  private fuzzy = new Map<string, T>();

  set(url: string, value: T): void {
    this.exact.set(url, value);
    const c = canonicalizeUrl(url);
    if (!this.canonical.has(c)) this.canonical.set(c, value);
    const f = canonicalizeUrl(url, { foldPathCase: true });
    if (!this.fuzzy.has(f)) this.fuzzy.set(f, value);
  }

  /** Merge into an existing entry (or seed it) — for indexes that accumulate. */
  upsert(url: string, seed: () => T, merge: (existing: T) => void): T {
    const found = this.lookup(url);
    if (found.value !== undefined) {
      merge(found.value);
      return found.value;
    }
    const created = seed();
    this.set(url, created);
    return created;
  }

  lookup(url: string): UrlLookup<T> {
    const e = this.exact.get(url);
    if (e !== undefined) return { value: e, match: "exact" };
    const c = this.canonical.get(canonicalizeUrl(url));
    if (c !== undefined) return { value: c, match: "canonical" };
    const f = this.fuzzy.get(canonicalizeUrl(url, { foldPathCase: true }));
    if (f !== undefined) return { value: f, match: "fuzzy" };
    return { value: undefined, match: "miss" };
  }

  get(url: string): T | undefined {
    return this.lookup(url).value;
  }

  has(url: string): boolean {
    return this.lookup(url).value !== undefined;
  }

  get size(): number {
    return this.exact.size;
  }

  values(): IterableIterator<T> {
    return this.exact.values();
  }
}

/** Same-site test that tolerates www/protocol drift. */
export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, "");
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, "");
    return ha === hb;
  } catch {
    return false;
  }
}