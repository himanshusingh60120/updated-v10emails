import { classifyCsv, classifyInlinksPurpose } from "../src/components/Upload";
import { parseInlinksExport } from "../src/lib/parse";
import { attachCrawlInlinkSources } from "../src/lib/sources";
import type { Issue } from "../src/lib/schema";

async function main(): Promise<void> {
  const inlinks = new File(
    ['"Type","Source","Destination"\n"Image","https://example.com/a","https://example.com/b"'],
    "all_inlinks.csv"
  );
  const crawl = new File(
    ['"Address","Content Type","Status Code"\n"https://example.com/","text/html",200'],
    "internal_all.csv"
  );
  const gsc = new File(
    ['"Page","Clicks","Impressions"\n"https://example.com/",1,10'],
    "gsc.csv"
  );

  const [inlinksKind, crawlKind, gscKind] = await Promise.all([
    classifyCsv(inlinks),
    classifyCsv(crawl),
    classifyCsv(gsc),
  ]);
  if (inlinksKind !== "inlinks") throw new Error(`single All Inlinks file classified as ${inlinksKind}`);
  if (crawlKind !== "crawl") throw new Error(`Internal: All classified as ${crawlKind}`);
  if (gscKind !== "gsc") throw new Error(`single GSC CSV classified as ${gscKind}`);
  if (classifyInlinksPurpose("all_inlinks.csv") !== "all") throw new Error("All Inlinks did not route to the full graph");
  if (classifyInlinksPurpose("client_error_(4xx)_inlinks.csv") !== "errors") {
    throw new Error("4xx Inlinks did not route to broken-URL source tracing");
  }
  const brokenTarget = "https://example.com/broken-image.webp";
  const errorInlinksCsv =
    `"Type","Source","Destination","Status Code","Alt Text","Link Position","Link Path"\n` +
    `"Image","https://example.com/article","${brokenTarget}",404,"Article image","Content","//article/img"`;
  const inlinkEdges = await parseInlinksExport(
    errorInlinksCsv as unknown as File,
    () => undefined
  );
  const brokenIssue: Issue = {
    id: `http-4xx::${brokenTarget}`,
    ruleId: "http-4xx",
    ruleLabel: "4xx client error",
    severity: "Critical",
    owner: "Dev",
    url: brokenTarget,
    evidence: "HTTP 404",
    verification: "CONFIRMED",
    impactScore: 0,
    fixStatus: "Open",
  };
  const traced = attachCrawlInlinkSources([brokenIssue], inlinkEdges.edges).issues[0];
  if (traced.sourceInlinkCount !== 1 || traced.sourceSamples?.[0]?.url !== "https://example.com/article") {
    throw new Error("filtered 4xx Inlinks export did not attach the linking page to the broken URL");
  }
  console.log("single-file CSV routing assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
