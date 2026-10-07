import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "node:zlib";
import {
  SitemapEntry,
  SitemapFetchResult,
  SitemapFile,
  SitemapRequestSchema,
} from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA = "Mozilla/5.0 (compatible; AuditForgeBot/1.0; SEO audit verification)";
const FETCH_TIMEOUT_MS = 15_000;
/** Per Google: 50,000 URLs and 50MB uncompressed per sitemap file. */
const URLS_PER_FILE_LIMIT = 50_000;
const BYTES_PER_FILE_LIMIT = 50 * 1024 * 1024;
/** Stop pulling bodies once one request has moved this much. */
const TOTAL_BYTE_BUDGET = 120 * 1024 * 1024;

/** Paths worth probing when robots.txt declares nothing. */
const WELL_KNOWN = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap.xml.gz",
  "/wp-sitemap.xml",
  "/sitemap1.xml",
  "/sitemaps.xml",
];

interface Fetched {
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  gzipped: boolean;
  error?: string;
}

/**
 * Fetch a sitemap body, inflating gzip when present.
 *
 * The previous implementation called `res.text()` unconditionally. A
 * `sitemap.xml.gz` — what Yoast, Shopify and most large sites serve — came back
 * as binary, matched no regex, and produced zero URLs with no error, so the UI
 * reported "Module C enabled" over an empty set.
 */
async function fetchSitemap(url: string): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" },
      signal: controller.signal,
      cache: "no-store",
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      return { status: res.status, contentType, body: "", bytes: 0, gzipped: false, error: `HTTP ${res.status}` };
    }
    const raw = Buffer.from(await res.arrayBuffer());
    // Two ways a body arrives compressed: the transport layer (already inflated
    // by fetch) or the file itself being a .gz served as an opaque stream. Only
    // the second needs handling — detect by magic bytes, not by file extension,
    // because plenty of servers hand back gzip from a plain .xml URL.
    const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    let buf: Buffer = raw;
    let gzipped = false;
    if (isGzip) {
      try {
        buf = gunzipSync(raw);
        gzipped = true;
      } catch (e) {
        return {
          status: res.status,
          contentType,
          body: "",
          bytes: raw.length,
          gzipped: true,
          error: `Body is gzip but could not be inflated: ${e instanceof Error ? e.message : "corrupt"}`,
        };
      }
    }
    return {
      status: res.status,
      contentType,
      body: buf.toString("utf8"),
      // The 50MB limit applies to the UNCOMPRESSED size, which is why this is
      // measured after inflation rather than on the wire bytes.
      bytes: buf.length,
      gzipped,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return {
      status: 0,
      contentType: "",
      body: "",
      bytes: 0,
      gzipped: false,
      error: /abort/i.test(msg) ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* XML                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Namespace-tolerant tag matcher.
 *
 * `<ns0:loc>` and `<sitemap:loc>` are both legal and both missed by a bare
 * `<loc[^>]*>`. The `\b` after the tag name is what stops `<urlset …>` being
 * matched as an opening `<url>` — the previous regex matched it and produced
 * correct output only by accident.
 */
function tagRegex(tag: string): RegExp {
  return new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${tag}\\s*>`,
    "gi"
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** Unwrap CDATA, decode entities, trim. A `<loc>` full of `&amp;` is a real URL. */
function textValue(raw: string): string {
  let s = raw.trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) s = cdata[1];
  s = s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
  s = s.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)));
  return s.trim();
}

function first(tag: string, xml: string): string {
  const m = tagRegex(tag).exec(xml);
  return m ? textValue(m[1]) : "";
}

function blocks(tag: string, xml: string): string[] {
  const re = tagRegex(tag);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** `<xhtml:link rel="alternate" hreflang="de" href="…">` inside a `<url>`. */
function alternates(block: string): { hreflang: string; href: string }[] {
  const out: { hreflang: string; href: string }[] = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    const hreflang = tag.match(/hreflang\s*=\s*["']([^"']+)["']/i)?.[1];
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (hreflang && href) out.push({ hreflang, href: textValue(href) });
  }
  return out;
}

function detectExtension(block: string): SitemapEntry["extension"] {
  if (/<(?:[A-Za-z0-9_.-]+:)?image\b/i.test(block)) return "image";
  if (/<(?:[A-Za-z0-9_.-]+:)?video\b/i.test(block)) return "video";
  if (/<(?:[A-Za-z0-9_.-]+:)?news\b/i.test(block)) return "news";
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                    */
/* -------------------------------------------------------------------------- */

interface RobotsDiscovery {
  declared: string[];
  status: number;
  fetched: boolean;
}

/**
 * Read every `Sitemap:` directive from robots.txt.
 *
 * They are global directives: any case, anywhere in the file, outside any
 * user-agent group. This is the authoritative list — a site with eight sitemaps
 * declares all eight here, and asking a user to paste one URL finds at most one.
 */
async function discoverFromRobots(origin: string): Promise<RobotsDiscovery> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return { declared: [], status: res.status, fetched: true };
    const text = await res.text();
    const declared: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (!m) continue;
      try {
        declared.push(new URL(m[1], origin).toString());
      } catch {
        /* malformed directive — surfaced as a finding by the rule engine */
      }
    }
    return { declared: [...new Set(declared)], status: res.status, fetched: true };
  } catch {
    return { declared: [], status: 0, fetched: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the well-known locations, cheapest first. */
async function probeWellKnown(origin: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of WELL_KNOWN) {
    const url = `${origin}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const res = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": UA },
        signal: controller.signal,
        cache: "no-store",
        redirect: "follow",
      });
      if (res.ok) found.push(url);
    } catch {
      /* probe miss — expected for most of these paths */
    } finally {
      clearTimeout(timer);
    }
    // One confirmed root is enough; an index fans out to the rest.
    if (found.length >= 2) break;
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                      */
/* -------------------------------------------------------------------------- */

interface QueueItem {
  url: string;
  depth: number;
  via: SitemapFile["discoveredVia"];
}

export async function POST(req: NextRequest) {
  let body: SitemapRequestParsed;
  try {
    const json = (await req.json()) as Record<string, unknown>;
    // Back-compat with the original single-URL shape: { url: "…" }.
    if (json && typeof json.url === "string") json.urls = [json.url];
    body = SitemapRequestSchema.parse(json);
  } catch {
    return NextResponse.json(
      {
        error:
          "Provide { urls: ['https://…/sitemap.xml'] } and/or { origin: 'https://example.com' } " +
          "to auto-discover from robots.txt.",
      },
      { status: 400 }
    );
  }

  const warnings: string[] = [];
  const files: SitemapFile[] = [];
  const entries: SitemapEntry[] = [];
  const seenFiles = new Set<string>();
  let robotsDeclared: string[] = [];
  let robotsStatus = 0;
  let robotsFetched = false;
  let totalBytes = 0;
  let truncated = false;

  const queue: QueueItem[] = body.urls.map((u) => ({ url: u, depth: 0, via: "manual" as const }));

  if (body.origin && !body.manualOnly) {
    const robots = await discoverFromRobots(body.origin);
    robotsDeclared = robots.declared;
    robotsStatus = robots.status;
    robotsFetched = robots.fetched;
    for (const u of robots.declared) {
      if (!queue.some((q) => q.url === u)) queue.push({ url: u, depth: 0, via: "robots.txt" });
    }
    if (robots.declared.length === 0) {
      const probed = await probeWellKnown(body.origin);
      for (const u of probed) {
        if (!queue.some((q) => q.url === u)) queue.push({ url: u, depth: 0, via: "probe" });
      }
      warnings.push(
        robots.fetched
          ? "robots.txt declares no Sitemap: directive — crawlers rely on that line to find your sitemaps."
          : "robots.txt could not be fetched, so discovery fell back to probing well-known paths."
      );
    }
  }

  if (queue.length === 0) {
    return NextResponse.json(
      { error: "No sitemap URL supplied and none could be discovered. Paste one, or pass an origin." },
      { status: 400 }
    );
  }

  while (queue.length > 0 && files.length < body.maxFiles && entries.length < body.maxUrls) {
    const item = queue.shift()!;
    if (seenFiles.has(item.url)) continue;
    seenFiles.add(item.url);

    if (totalBytes > TOTAL_BYTE_BUDGET) {
      truncated = true;
      warnings.push(
        `Stopped after ${(totalBytes / 1024 / 1024).toFixed(0)}MB of sitemap data in one request. ` +
          `Re-run against the remaining sitemap URLs to continue.`
      );
      break;
    }

    const res = await fetchSitemap(item.url);
    totalBytes += res.bytes;

    if (res.error || !res.body) {
      files.push({
        url: item.url,
        status: res.status,
        contentType: res.contentType,
        gzipped: res.gzipped,
        bytes: res.bytes,
        kind: "unreadable",
        urlCount: 0,
        depth: item.depth,
        error: res.error ?? "Empty body",
        discoveredVia: item.via,
      });
      continue;
    }

    const isIndex = /<(?:[A-Za-z0-9_.-]+:)?sitemapindex\b/i.test(res.body);
    const isUrlset = /<(?:[A-Za-z0-9_.-]+:)?urlset\b/i.test(res.body);

    if (!isIndex && !isUrlset) {
      files.push({
        url: item.url,
        status: res.status,
        contentType: res.contentType,
        gzipped: res.gzipped,
        bytes: res.bytes,
        kind: "unreadable",
        urlCount: 0,
        depth: item.depth,
        error:
          "Body is not a <urlset> or <sitemapindex>. " +
          (/^\s*</.test(res.body)
            ? "It is XML, but not a sitemap."
            : "It looks like HTML — most likely a 404 page served with a 200."),
        discoveredVia: item.via,
      });
      continue;
    }

    if (isIndex) {
      let queued = 0;
      for (const block of blocks("sitemap", res.body)) {
        const loc = first("loc", block);
        if (!loc) continue;
        try {
          const abs = new URL(loc, item.url).toString();
          if (!seenFiles.has(abs)) {
            queue.push({ url: abs, depth: item.depth + 1, via: "sitemap-index" });
            queued++;
          }
        } catch {
          warnings.push(`Sitemap index ${item.url} contains an unparseable <loc>: ${loc.slice(0, 120)}`);
        }
      }
      files.push({
        url: item.url,
        status: res.status,
        contentType: res.contentType,
        gzipped: res.gzipped,
        bytes: res.bytes,
        kind: "index",
        urlCount: queued,
        depth: item.depth,
        discoveredVia: item.via,
      });
      continue;
    }

    const urlBlocks = blocks("url", res.body);
    let added = 0;
    for (const block of urlBlocks) {
      if (entries.length >= body.maxUrls) {
        truncated = true;
        break;
      }
      const loc = first("loc", block);
      if (!loc) continue;
      const alts = alternates(block);
      entries.push({
        loc,
        foundIn: item.url,
        lastmod: first("lastmod", block) || undefined,
        changefreq: first("changefreq", block) || undefined,
        priority: first("priority", block) || undefined,
        alternates: alts.length > 0 ? alts : undefined,
        extension: detectExtension(block),
      });
      added++;
    }

    files.push({
      url: item.url,
      status: res.status,
      contentType: res.contentType,
      gzipped: res.gzipped,
      bytes: res.bytes,
      kind: "urlset",
      urlCount: urlBlocks.length,
      depth: item.depth,
      discoveredVia: item.via,
      error:
        urlBlocks.length > 0 && added === 0
          ? "Contains <url> entries but none has a readable <loc>."
          : undefined,
    });

    if (urlBlocks.length > URLS_PER_FILE_LIMIT) {
      warnings.push(
        `${item.url} holds ${urlBlocks.length.toLocaleString()} URLs, past the ${URLS_PER_FILE_LIMIT.toLocaleString()} limit. Split it.`
      );
    }
    if (res.bytes > BYTES_PER_FILE_LIMIT) {
      warnings.push(
        `${item.url} is ${(res.bytes / 1024 / 1024).toFixed(1)}MB uncompressed, past the 50MB limit. Split it.`
      );
    }
  }

  if (queue.length > 0) {
    truncated = true;
    warnings.push(
      `Stopped after ${files.length} sitemap files; ${queue.length} still unfetched. ` +
        `Raise maxFiles or re-run against the remaining index children.`
    );
  }

  const result: SitemapFetchResult = {
    entries,
    files,
    robotsDeclared,
    robotsStatus,
    robotsFetched,
    truncated,
    warnings,
  };

  // Flat `urls` stays in the payload so callers written against the original
  // response shape keep working unchanged.
  return NextResponse.json({ ...result, urls: entries.map((e) => e.loc) });
}

type SitemapRequestParsed = ReturnType<typeof SitemapRequestSchema.parse>;