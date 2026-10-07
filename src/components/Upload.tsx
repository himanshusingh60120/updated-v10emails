"use client";
import { useCallback, useRef, useState } from "react";

const ACCEPT = [".csv", ".xlsx", ".seospider", ".dbseospider", ".bat"];
const GB = 1024 * 1024 * 1024;

/**
 * Limits differ by format because the parsers differ:
 *  - CSV is stream-parsed chunk by chunk, so the file never sits in memory whole.
 *    Effectively unlimited; the cap is a sanity check.
 *  - XLSX and .dbseospider MUST be loaded into memory in full (SheetJS needs the
 *    whole workbook; SQLite needs the whole database). Past roughly 1.5GB a
 *    browser tab runs out of address space no matter what we allow here.
 */
const LIMITS: { ext: string; max: number; streamed: boolean }[] = [
  { ext: ".csv", max: 16 * GB, streamed: true },
  { ext: ".xlsx", max: 2 * GB, streamed: false },
  { ext: ".dbseospider", max: 2 * GB, streamed: false },
  { ext: ".seospider", max: 2 * GB, streamed: false },
];

const fmtSize = (bytes: number): string =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)}GB` : `${Math.round(bytes / 1024 / 1024)}MB`;

function FileSlot({
  accept,
  disabled,
  fileName,
  placeholder,
  onSelect,
}: {
  accept: string;
  disabled: boolean;
  fileName?: string;
  placeholder: string;
  onSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-label={`File picker: ${placeholder}`}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.currentTarget.value = "";
        }}
      />
      <button type="button" className="btn shrink-0 text-xs" disabled={disabled} onClick={() => inputRef.current?.click()}>
        Choose file
      </button>
      <span aria-live="polite" className={`min-w-0 truncate text-xs ${fileName ? "text-slate-200" : "text-steel/70"}`} title={fileName}>
        {fileName || placeholder}
      </span>
    </div>
  );
}

export function validateCrawlFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".bat") || name.endsWith(".cmd")) {
    return (
      "That's the converter — it runs on your computer, not here.\n\n" +
      "1. Close Screaming Frog completely (check the system tray)\n" +
      "2. In Windows Explorer, drag your .dbseospider file ONTO this .bat file\n" +
      "3. A window opens and runs the export — wait for SUCCESS\n" +
      "4. It creates an \"auditforge-export\" folder next to your project file\n" +
      "5. Come back here and drop internal_all.csv on this upload zone\n" +
      "6. Add all_inlinks.csv in the \"All Inlinks\" slot for link-equity modeling"
    );
  }
  const rule = LIMITS.find((l) => name.endsWith(l.ext));
  if (!rule) return `"${file.name}" isn't an accepted format. Upload ${ACCEPT.join(", ")}.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > rule.max) {
    return rule.streamed
      ? `"${file.name}" is ${fmtSize(file.size)}, past the ${fmtSize(rule.max)} ceiling. Split the export and audit it in parts.`
      : `"${file.name}" is ${fmtSize(file.size)}. ${rule.ext} files must be loaded into memory whole, and browsers run out of address space past ${fmtSize(
          rule.max
        )}. Export "Internal: All" as CSV from Screaming Frog instead — CSV is stream-parsed, so size stops mattering.`;
  }
  return null;
}

/** Non-blocking heads-up for files that are legal but heavy. */
export function crawlFileWarning(file: File): string | null {
  const name = file.name.toLowerCase();
  const streamed = name.endsWith(".csv");
  if (!streamed && file.size > 700 * 1024 * 1024) {
    return `${fmtSize(file.size)} ${name.endsWith(".xlsx") ? "XLSX" : "project file"} — this format loads into memory whole, so the tab may run heavy or crash. If it struggles, export "Internal: All" as CSV (stream-parsed, no size ceiling) and use that instead.`;
  }
  if (streamed && file.size > 2 * GB) {
    return `${fmtSize(file.size)} CSV — parsing streams fine, but a crawl this large produces a lot of rows to hold in memory. Close other tabs before starting.`;
  }
  return null;
}

/** Classify a CSV by its header row so multiple files can be dropped together. */
export async function classifyCsv(file: File): Promise<"crawl" | "inlinks" | "gsc" | "issues"> {
  try {
    const head = (await file.slice(0, 4096).text()).toLowerCase();
    const firstLine = head.split(/\r?\n/)[0] ?? "";
    // Checked first: this header also contains "urls", which would otherwise
    // fall through to the crawl branch.
    if (firstLine.includes("issue name") && firstLine.includes("issue priority")) return "issues";
    // Any Source+Destination export is a link graph: All Inlinks, All Outlinks,
    // or the Response Codes → 4xx/5xx Inlinks exports. They share a schema, and
    // the 4xx one is the single best input for tracing broken links, so route
    // them all to the same parser rather than only recognising All Inlinks.
    if (firstLine.includes("source") && firstLine.includes("destination")) return "inlinks";
    if ((firstLine.includes("address") || firstLine.includes("url")) && head.includes("status code")) return "crawl";
    if (firstLine.includes("clicks") && firstLine.includes("impressions")) return "gsc";
  } catch {
    /* unreadable head — let the crawl parser produce the real error */
  }
  return "crawl";
}

export function classifyInlinksPurpose(fileName: string): "all" | "errors" {
  return /client.?error|4xx|5xx/i.test(fileName) ? "errors" : "all";
}

interface Props {
  onCrawlFile: (f: File) => void;
  onInlinksFile: (f: File, purpose: "all" | "errors") => void | Promise<void>;
  onGscFile: (f: File) => void;
  onIssuesFile: (f: File) => void;
  onSitemapUrl: (u: string) => void;
  onPreviousAudit: (f: File) => void;
  onDownloadConverter: () => void;
  busy: boolean;
  gscStatus: "unknown" | "unconfigured" | "disconnected" | "connected";
  gscSites: string[];
  gscSite: string;
  onGscConnect: () => void;
  onGscSelect: (site: string) => void;
  onGscDisconnect: () => void;
}

export default function Upload({
  onCrawlFile,
  onInlinksFile,
  onGscFile,
  onIssuesFile,
  onSitemapUrl,
  onPreviousAudit,
  onDownloadConverter,
  busy,
  gscStatus,
  gscSites,
  gscSite,
  onGscConnect,
  onGscSelect,
  onGscDisconnect,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [sitemap, setSitemap] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const handleFiles = useCallback(
    async (fileList: FileList | null | undefined) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;
      setError("");
      setWarning("");

      const routed: string[] = [];
      let crawlFile: File | null = null;
      for (const file of files) {
        const name = file.name.toLowerCase();
        if (name.endsWith(".csv")) {
          const kind = await classifyCsv(file);
          if (kind === "inlinks") {
            const purpose = classifyInlinksPurpose(file.name);
            const slot = purpose === "errors" ? "brokenLinks" : "inlinks";
            setSelectedFiles((prev) => ({ ...prev, [slot]: file.name }));
            await onInlinksFile(file, purpose);
            routed.push(
              purpose === "errors"
                ? `${file.name} → broken-URL source tracing`
                : `${file.name} → full link graph / PageRank`
            );
            continue;
          }
          if (kind === "gsc") {
            setSelectedFiles((prev) => ({ ...prev, gsc: file.name }));
            onGscFile(file);
            routed.push(`${file.name} → GSC enrichment`);
            continue;
          }
          if (kind === "issues") {
            setSelectedFiles((prev) => ({ ...prev, issues: file.name }));
            onIssuesFile(file);
            routed.push(`${file.name} → Issues Overview (cross-check)`);
            continue;
          }
        }
        if (crawlFile) {
          setError("Drop one crawl file at a time (plus optional all_inlinks.csv / GSC CSV alongside it).");
          return;
        }
        crawlFile = file;
      }
      if (routed.length > 0) setWarning(`Auto-routed: ${routed.join(" · ")}`);
      if (!crawlFile) return;
      setSelectedFiles((prev) => ({ ...prev, crawl: crawlFile!.name }));
      const err = validateCrawlFile(crawlFile);
      if (err) {
        setError(err);
        return;
      }
      const w = crawlFileWarning(crawlFile);
      if (w) setWarning((prev) => (prev ? `${prev}\n${w}` : w));
      onCrawlFile(crawlFile);
    },
    [onCrawlFile, onInlinksFile, onGscFile, onIssuesFile]
  );

  return (
    <div className="space-y-6">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload Screaming Frog crawl file"
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-8 py-14 text-center transition ${
          dragging ? "border-forge bg-forge/5" : "border-edge bg-panel/50 hover:border-steel"
        } ${busy ? "pointer-events-none opacity-50" : ""}`}
      >
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-forge">crawl input</p>
        <p className="mt-3 text-lg">Drop your Screaming Frog crawl here</p>
        <p className="mt-2 text-sm text-steel">
          Choose or drop an &quot;Internal: All&quot; CSV, XLSX, .seospider project, or converter .bat.
        </p>
        <p className="mt-3 rounded border border-edge bg-ink/70 px-3 py-2 text-left text-xs text-steel" aria-live="polite">
          {selectedFiles.crawl || "No crawl file selected"}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT.join(",")}
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {error && (
        <div role="alert" className="whitespace-pre-wrap rounded border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
          {error}
        </div>
      )}
      {warning && (
        <p className="whitespace-pre-wrap rounded border border-forge/50 bg-forge/10 px-3 py-2 text-sm text-forge">{warning}</p>
      )}

      <section className="rounded border border-edge bg-panel/50 p-4" aria-labelledby="export-steps-title">
        <h2 id="export-steps-title" className="font-mono text-xs uppercase tracking-widest text-forge">
          Export and add your files
        </h2>
        <ol className="mt-3 grid gap-2 text-xs leading-relaxed text-steel sm:grid-cols-2">
          <li><strong className="text-slate-200">1. Crawl:</strong> In Screaming Frog, open the <em>Internal</em> tab and export <em>Internal: All</em> as CSV. Choose it in the crawl box above.</li>
          <li><strong className="text-slate-200">2. Link sources:</strong> Use <em>Bulk Export → Links → All Inlinks</em> for the internal link graph, or <em>Bulk Export → Response Codes → Client Error (4xx) Inlinks</em> to trace broken URLs.</li>
          <li><strong className="text-slate-200">3. Compare coverage:</strong> Export <em>Reports → Issues Overview</em> as CSV, then add it in the Issues Overview slot.</li>
          <li><strong className="text-slate-200">4. Add search data:</strong> Connect Search Console below, or export <em>Performance → Pages</em> as CSV and choose the GSC file slot.</li>
          <li><strong className="text-slate-200">5. Compare audits:</strong> Export Audit JSON from an earlier report, then add it in the previous-audit slot.</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3 text-xs text-steel">
          <span><strong className="text-slate-200">Have a .dbseospider project?</strong> Download the converter, close Screaming Frog, then drag the project file onto the downloaded .bat. Select the generated internal_all.csv and all_inlinks.csv together.</span>
          <button type="button" className="btn shrink-0 text-xs" onClick={onDownloadConverter}>
            Download converter (.bat)
          </button>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · All Inlinks export
          </span>
          <span className="mt-1 block text-xs text-steel">
            Supporting link graph for Module D, not a crawl URL list: each row is a source → destination edge, so
            many rows can point to the same page. Put <em>Internal: All</em> in the main crawl box. For .dbseospider
            projects we try to read the edges automatically.
          </span>
          <FileSlot
            accept=".csv"
            disabled={busy}
            fileName={selectedFiles.inlinks}
            placeholder="No All Inlinks file selected"
            onSelect={(file) => {
              setSelectedFiles((prev) => ({ ...prev, inlinks: file.name }));
              onInlinksFile(file, "all");
            }}
          />
        </div>
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-forge">
            recommended · 4xx / 5xx inlinks export
          </span>
          <span className="mt-1 block text-xs text-steel">
            Bulk Export → Response Codes → <em>Internal Client Error (4xx) Inlinks</em>. This is what answers
            &quot;this 404 exists — from where?&quot;: it names the linking page, the anchor text, the link type
            and, with Link Position / Link Path enabled, exactly where in the template the link sits. Far smaller
            than All Inlinks because it is pre-filtered to broken targets.
          </span>
          <FileSlot
            accept=".csv"
            disabled={busy}
            fileName={selectedFiles.brokenLinks}
            placeholder="No 4xx / 5xx inlinks file selected"
            onSelect={(file) => {
              setSelectedFiles((prev) => ({ ...prev, brokenLinks: file.name }));
              onInlinksFile(file, "errors");
            }}
          />
        </div>
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            google search console — automatic
          </span>
          {gscStatus === "connected" ? (
            <>
              <span className="mt-1 block text-xs text-verdant">
                ✓ Connected. Pick the property — clicks/impressions are pulled automatically during every audit.
              </span>
              <div className="mt-2 flex gap-2">
                <select
                  aria-label="GSC property"
                  value={gscSite}
                  disabled={busy}
                  onChange={(e) => onGscSelect(e.target.value)}
                  className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-200"
                >
                  <option value="">Auto-match property to crawl domain</option>
                  {gscSites.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn text-xs" onClick={onGscDisconnect} disabled={busy}>
                  Disconnect
                </button>
              </div>
            </>
          ) : gscStatus === "unconfigured" ? (
            <span className="mt-1 block text-xs text-steel">
              OAuth keys not set on this deployment (see README). Fallback: upload the Search Console
              Performance → Pages CSV below.
            </span>
          ) : (
            <>
              <span className="mt-1 block text-xs text-steel">
                Connect once — every audit then pulls clicks/impressions per URL automatically. Unlocks
                traffic-weighted Impact Scores &amp; money leaks.
              </span>
              <button type="button" className="btn mt-2 text-xs" onClick={onGscConnect} disabled={busy || gscStatus === "unknown"}>
                Connect Google Search Console
              </button>
            </>
          )}
          {gscStatus !== "connected" && (
            <FileSlot
              accept=".csv"
              disabled={busy}
              fileName={selectedFiles.gsc}
              placeholder="No GSC Pages CSV selected"
              onSelect={(file) => {
                setSelectedFiles((prev) => ({ ...prev, gsc: file.name }));
                onGscFile(file);
              }}
            />
          )}
        </div>
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · Issues Overview export
          </span>
          <span className="mt-1 block text-xs text-steel">
            Screaming Frog&apos;s own issue counts (Reports → Issues Overview). Cross-checked against what AuditForge
            detects to prove the crawl export is complete, catch missing columns, and rank what isn&apos;t covered yet.
          </span>
          <FileSlot
            accept=".csv"
            disabled={busy}
            fileName={selectedFiles.issues}
            placeholder="No Issues Overview CSV selected"
            onSelect={(file) => {
              setSelectedFiles((prev) => ({ ...prev, issues: file.name }));
              onIssuesFile(file);
            }}
          />
        </div>
        <label className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · sitemap URL (auto-discovered)
          </span>
          <span className="mt-1 block text-xs text-steel">
            Sitemaps are found automatically from robots.txt when the crawl loads, including gzipped ones and
            every child of a sitemap index. Paste a URL only to audit one that robots.txt does not declare.
          </span>
          <div className="mt-2 flex gap-2">
            <input
              type="url"
              placeholder="https://example.com/sitemap.xml"
              value={sitemap}
              disabled={busy}
              onChange={(e) => setSitemap(e.target.value)}
              className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-200 placeholder:text-steel/50"
            />
            <button
              type="button"
              className="btn text-xs"
              disabled={busy || !/^https?:\/\//.test(sitemap)}
              onClick={() => onSitemapUrl(sitemap)}
            >
              Add
            </button>
          </div>
        </label>
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · previous audit (.json)
          </span>
          <span className="mt-1 block text-xs text-steel">Unlocks delta report: new / fixed / regressed (Module F)</span>
          <FileSlot
            accept=".json"
            disabled={busy}
            fileName={selectedFiles.previous}
            placeholder="No previous audit selected"
            onSelect={(file) => {
              setSelectedFiles((prev) => ({ ...prev, previous: file.name }));
              onPreviousAudit(file);
            }}
          />
        </div>
      </div>
    </div>
  );
}