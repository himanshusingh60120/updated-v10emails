import { NextRequest } from "next/server";
import { POST } from "../src/app/api/verify/route";

type CheckResult = {
  status: string;
  liveEvidence: string;
  verifyError?: string;
  headerFindings?: { check: string; grade: string }[];
  internalLinks?: { url: string }[];
};
type MockFetch = (url: string) => Promise<Response>;

let sequence = 0;
const originalFetch = globalThis.fetch;

function assert(label: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${label}${detail ? ` (${detail})` : ""}`);
  console.log(`  ok — ${label}`);
}

async function verify(
  ruleId: string,
  options: {
    status?: number;
    html?: string;
    headers?: Record<string, string>;
    mock?: MockFetch;
    collectHeaders?: boolean;
    collectLinks?: boolean;
    crawlEvidence?: string;
  } = {}
): Promise<CheckResult> {
  const id = ++sequence;
  const url = `https://audit-${id}.example.test/page`;
  const body = options.html ?? "<html><head><title>Example</title></head><body><main>Content</main></body></html>";
  globalThis.fetch = async (input) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (requestUrl.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (options.mock) return options.mock(requestUrl);
    return new Response(body, {
      status: options.status ?? 200,
      headers: options.headers ?? { "content-type": "text/html; charset=utf-8" },
    });
  };

  const req = new NextRequest("http://localhost/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pages: [{
        url,
        checks: [{ issueId: `test-${id}`, ruleId, crawlEvidence: options.crawlEvidence ?? "old crawl evidence" }],
        collectLinks: options.collectLinks,
      }],
      collectHeaders: options.collectHeaders ?? false,
    }),
  });
  const response = await POST(req);
  const payload = (await response.json()) as { results: CheckResult[] };
  if (!payload.results?.[0]) throw new Error(`No result returned for ${ruleId}`);
  return payload.results[0];
}

async function main(): Promise<void> {
  console.log("\nLive verification regressions");

  const changedTo404 = await verify("title-missing", { status: 404, html: "<html><head></head><body>gone</body></html>" });
  assert("content checks do not confirm on a 404", changedTo404.status === "UNVERIFIABLE");

  const pdf = await verify("title-missing", { headers: { "content-type": "application/pdf" }, html: "%PDF-1.7" });
  assert("content checks do not run on PDFs", pdf.status === "UNVERIFIABLE");

  const forbidden = await verify("http-4xx", { status: 403 });
  const unauthorized = await verify("http-4xx", { status: 401 });
  const rateLimited = await verify("http-4xx", { status: 429 });
  const challenge = await verify("http-4xx", {
    html: "<html><head><title>Checking your browser</title></head><body>Access denied</body></html>",
  });
  assert("403 bot blocks are not confirmed as broken URLs", forbidden.status === "UNVERIFIABLE");
  assert("401 access controls are not confirmed as broken URLs", unauthorized.status === "UNVERIFIABLE");
  assert("429 rate limits are not confirmed as broken URLs", rateLimited.status === "UNVERIFIABLE");
  assert("200-status challenge pages are not treated as resolved errors", challenge.status === "UNVERIFIABLE");

  const actualLoop = await verify("redirect-loop", {
    mock: async (requestUrl) => {
      const current = new URL(requestUrl);
      const nextPath = current.pathname === "/page" ? "/middle" : "/page";
      return new Response(null, { status: 301, headers: { location: `${current.origin}${nextPath}` } });
    },
  });
  assert("a repeated live redirect URL confirms a loop", actualLoop.status === "CONFIRMED");

  const longChain = await verify("redirect-loop", {
    mock: async (requestUrl) => {
      const current = new URL(requestUrl);
      const step = current.pathname === "/page" ? 0 : Number(current.pathname.split("/").pop());
      return new Response(null, {
        status: 301,
        headers: { location: `${current.origin}/step/${step + 1}` },
      });
    },
  });
  assert("a long redirect chain is not called a loop", longChain.status === "UNVERIFIABLE");

  const xRobots = await verify("nofollow-directive", {
    headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" },
  });
  assert("X-Robots-Tag nofollow is honored", xRobots.status === "CONFIRMED");

  const security = await verify("http-5xx", {
    collectHeaders: true,
    headers: {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
  const headerChecks = new Set((security.headerFindings ?? []).map((finding) => finding.check));
  assert("header audit includes CSP and clickjacking checks", headerChecks.has("Content-Security-Policy") && headerChecks.has("Clickjacking protection"));
  assert("header audit includes MIME and referrer policies", headerChecks.has("X-Content-Type-Options") && headerChecks.has("Referrer-Policy"));

  const canonical = await verify("canonical-to-non-200", {
    html: '<html><head><link rel="canonical" href="https://example.test/target"></head><body></body></html>',
  });
  assert("canonical target status is not guessed from the source page", canonical.status === "UNVERIFIABLE");

  const duplicate = await verify("title-duplicate", {
    html: "<html><head><title>Shared</title></head><body></body></html>",
  });
  assert("a single unchanged page cannot confirm a cross-page duplicate", duplicate.status === "UNVERIFIABLE");

  const mainWords = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const chromeWords = Array.from({ length: 220 }, (_, i) => `chrome${i}`).join(" ");
  const thin = await verify("thin-content", {
    html: `<html><body><nav>${chromeWords}</nav><main>${mainWords}</main><footer>${chromeWords}</footer></body></html>`,
  });
  assert("thin-content uses the main area instead of navigation and footer", thin.status === "CONFIRMED" && thin.liveEvidence.includes("40 words"), thin.liveEvidence);

  const redirectHost = `https://audit-${++sequence}.example.test`;
  const slow = await verify("slow-response", {
    mock: async (requestUrl) => {
      if (requestUrl === `${redirectHost}/page`) {
        await new Promise((resolve) => setTimeout(resolve, 550));
        return new Response(null, { status: 301, headers: { location: `${redirectHost}/middle` } });
      }
      if (requestUrl === `${redirectHost}/middle`) {
        await new Promise((resolve) => setTimeout(resolve, 550));
        return new Response(null, { status: 301, headers: { location: `${redirectHost}/final` } });
      }
      await new Promise((resolve) => setTimeout(resolve, 550));
      return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert("slow-response measures only the final redirect hop", slow.status === "RESOLVED", slow.liveEvidence);

  const unknownSize = await verify("oversized-resource", { headers: { "content-type": "application/pdf" } });
  assert("missing Content-Length does not prove a resource is oversized", unknownSize.status === "UNVERIFIABLE");

  const unknownRule = await verify("future-rule-not-adapted");
  assert("rules without a live verifier are not automatically confirmed", unknownRule.status === "UNVERIFIABLE");

  const failedTransport = await verify("no-response", {
    mock: async () => {
      throw new TypeError("socket closed");
    },
  });
  assert("a repeated transport failure confirms no-response", failedTransport.status === "CONFIRMED");

  const serverError = await verify("no-response", { status: 500 });
  assert("an HTTP 500 is not mislabeled as no-response", serverError.status === "RESOLVED");

  const fullCheck = await verify("full-site-url-check", { crawlEvidence: "Crawl HTTP 200" });
  assert("full-site checks confirm a live HTTP response", fullCheck.status === "CONFIRMED" && fullCheck.liveEvidence.includes("Live HTTP 200"));
  const harvestedFullCheck = await verify("full-site-url-check", {
    crawlEvidence: "Crawl HTTP 200",
    collectLinks: true,
    html: '<html><head></head><body><a href="/target">Target</a></body></html>',
  });
  const statusOnlyFullCheck = await verify("full-site-url-check", {
    crawlEvidence: "Crawl HTTP 200",
    collectLinks: false,
    html: '<html><head></head><body><a href="/target">Target</a></body></html>',
  });
  assert("selected issue URLs can harvest links", (harvestedFullCheck.internalLinks?.length ?? 0) > 0);
  assert("clean full-site status checks skip body/link harvesting", !statusOnlyFullCheck.internalLinks?.length);
  const fullCheck404 = await verify("full-site-url-check", { status: 404, crawlEvidence: "Crawl HTTP 200" });
  assert("full-site checks preserve newly broken HTTP status evidence", fullCheck404.status === "CONFIRMED" && fullCheck404.liveEvidence.includes("Live HTTP 404"));
  const fullCheckBlocked = await verify("full-site-url-check", { status: 403, crawlEvidence: "Crawl HTTP 200" });
  assert("full-site checks keep bot-blocked URLs unverifiable", fullCheckBlocked.status === "UNVERIFIABLE");

  const encoded = Buffer.concat([
    Buffer.from("<html><head><title>Caf", "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</title></head><body></body></html>", "ascii"),
  ]);
  const charset = await verify("title-short", {
    mock: async () => new Response(encoded, { status: 200, headers: { "content-type": "text/html; charset=windows-1252" } }),
  });
  assert("HTML title decoding honors the declared charset", charset.liveEvidence.includes("Café"), charset.liveEvidence);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
