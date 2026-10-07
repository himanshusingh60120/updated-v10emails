"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Upload from "@/components/Upload";
import Pipeline, { Stage } from "@/components/Pipeline";
import Report, { PsiResult } from "@/components/Report";
import LiveFindings, { emptyLiveStats, LiveStats } from "@/components/LiveFindings";
import VerifyControls from "@/components/VerifyControls";
import { downloadConverterBat } from "@/lib/converter-bat";
import {
  hyperlinkEdges,
  InlinkEdge,
  MAX_INLINK_EDGES,
  parseCrawlFile,
  parseGscPagesCsv,
  parseInlinksExport,
  parseIssuesOverviewCsv,
} from "@/lib/parse";
import { IssuesOverview, reconcileIssues } from "@/lib/issues-overview";
import { detectIssues, EXTENDED_RULE_IDS } from "@/lib/detect";
import {
  computeDelta,
  computeImpactScores,
  computePagerank,
  DeltaReport,
  healthScore,
} from "@/lib/analysis";
import { analyzeUrlHygiene, diffSitemap, HygieneFinding, SitemapDiff } from "@/lib/modules";
import {
  attachCrawlInlinkSources,
  attachGscSources,
  attachLiveSources,
  groupFixesByTemplate,
  tracedUrl,
} from "@/lib/sources";
import { auditSitemap, sitemapProbeIssues } from "@/lib/sitemap-rules";
import { runPreflight } from "@/lib/preflight";
import {
  changedLiveStatusFinding,
  createFullSiteUrlChecks,
  FULL_SITE_URL_CHECK_RULE_ID,
  summarizeFullSiteChecks,
} from "@/lib/full-site-check";
import { canonicalizeUrl, UrlIndex } from "@/lib/url-utils";
import { checkRobots, parseRobotsTxt, RobotsGroup } from "@/lib/robots";
import { BudgetConfig, BudgetSnapshot, CpuBudget, DEFAULT_BUDGET, fmtCpu, loadBudgetConfig } from "@/lib/cpu-budget";
import { hasStoredAudit, loadLatestAudit, pruneAudits, saveAudit } from "@/lib/checkpoint";
import { QueueStatus, VerifyQueue, VerifyRunResult } from "@/lib/verify-queue";
import {
  AuditState,
  FixStatus,
  InlinkSource,
  Issue,
  SitemapFetchResult,
  VerifyResultItem,
  severityRank,
} from "@/lib/schema";

/** Max confirmed error URLs traced via GSC URL Inspection per audit (quota: 2,000/day/property). */
const GSC_INSPECT_CAP = 40;
/**
 * Safety valve for very large crawls. The CPU governor is the real ceiling;
 * this stops a runaway export from queueing work no one will ever wait for.
 * Issues past the cap are marked SKIPPED, never silently dropped.
 */
const VERIFY_URL_CAP = 200_000;
/**
 * Extended content rules (the H2 checks) give Screaming Frog parity but force a
 * full-document fetch on every page they flag. Flip to false on very large
 * crawls to keep every page on the 64KB <head> tier.
 */
const EXTENDED_CONTENT_RULES = true;
const IDLE_STATUS: QueueStatus = { state: "idle", done: 0, total: 0, retrying: 0, wokeFromSuspend: false };

function newAudit(): AuditState {
  return {
    meta: {
      createdAt: new Date().toISOString(),
      name: "audit",
      auditId: Math.random().toString(36).slice(2, 10),
    },
    rows: [],
    issues: [],
    headerFindings: [],
    gsc: [],
    sitemapUrls: [],
    inlinksLoaded: false,
    parseWarnings: [],
  };
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [detail, setDetail] = useState("");
  const [progress, setProgress] = useState(-1);
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<AuditState>(newAudit);
  const [sitemapDiff, setSitemapDiff] = useState<SitemapDiff | null>(null);
  const [hygiene, setHygiene] = useState<HygieneFinding[]>([]);
  const [delta, setDelta] = useState<DeltaReport | null>(null);
  const [previousAudit, setPreviousAudit] = useState<AuditState | null>(null);
  const [psi, setPsi] = useState<PsiResult[]>([]);
  const [psiError, setPsiError] = useState("");
  const [moduleNotes, setModuleNotes] = useState<string[]>([]);
  const [resumable, setResumable] = useState(false);
  const [live, setLive] = useState<LiveStats>(emptyLiveStats);
  const [gscStatus, setGscStatus] = useState<"unknown" | "unconfigured" | "disconnected" | "connected">("unknown");
  const [gscSites, setGscSites] = useState<string[]>([]);
  const [gscSite, setGscSite] = useState("");

  // ── CPU budget ───────────────────────────────────────────────────────────
  const [queueStatus, setQueueStatus] = useState<QueueStatus>(IDLE_STATUS);
  const [budgetSnap, setBudgetSnap] = useState<BudgetSnapshot | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetConfig>(DEFAULT_BUDGET);
  const budgetRef = useRef<CpuBudget | null>(null);
  const queueRef = useRef<VerifyQueue | null>(null);

  const auditRef = useRef(audit);
  auditRef.current = audit;
  const gscRef = useRef({ status: gscStatus, site: gscSite, sites: gscSites });
  gscRef.current = { status: gscStatus, site: gscSite, sites: gscSites };
  const allInlinkEdgesRef = useRef<InlinkEdge[] | null>(null);
  const errorInlinkEdgesRef = useRef<InlinkEdge[] | null>(null);
  const sitemapRef = useRef<SitemapFetchResult | null>(null);
  const issuesOverviewRef = useRef<IssuesOverview | null>(null);

  // The budget touches localStorage, so it can only be built in the browser.
  useEffect(() => {
    const budget = new CpuBudget(loadBudgetConfig());
    budgetRef.current = budget;
    setBudgetConfig(budget.getConfig());
    return budget.subscribe(setBudgetSnap);
  }, []);

  // Resume: nothing lost on refresh.
  useEffect(() => {
    void hasStoredAudit().then(setResumable);
    try {
      setGscSite(localStorage.getItem("auditforge:gsc-site") ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);

  // GSC: probe the connection and surface OAuth redirect outcomes.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gsc") === "error") {
      setError(`Google Search Console connection failed: ${params.get("reason") ?? "unknown"}. You can retry or use the CSV fallback.`);
    }
    if (params.has("gsc")) window.history.replaceState({}, "", "/");
    (async () => {
      try {
        const res = await fetch("/api/gsc/sites");
        if (res.ok) {
          const data = (await res.json()) as { sites: string[] };
          setGscSites(data.sites);
          setGscStatus("connected");
        } else if (res.status === 501) setGscStatus("unconfigured");
        else setGscStatus("disconnected");
      } catch {
        setGscStatus("disconnected");
      }
    })();
  }, []);

  const handleGscSelect = useCallback((site: string) => {
    setGscSite(site);
    try {
      localStorage.setItem("auditforge:gsc-site", site);
    } catch {
      /* best effort */
    }
  }, []);

  const handleGscDisconnect = useCallback(async () => {
    await fetch("/api/gsc/disconnect", { method: "POST" }).catch(() => undefined);
    setGscStatus("disconnected");
    setGscSites([]);
  }, []);

  /** Auto-match a GSC property to the crawl's domain when the user hasn't picked one. */
  const resolveGscProperty = useCallback((crawlHost: string): string => {
    const { status, site, sites } = gscRef.current;
    if (status !== "connected") return "";
    if (site) return site;
    const host = crawlHost.replace(/^www\./, "");
    return (
      sites.find((s) => s === `sc-domain:${host}`) ??
      sites.find((s) => {
        try {
          return new URL(s).hostname.replace(/^www\./, "") === host;
        } catch {
          return false;
        }
      }) ??
      ""
    );
  }, []);

  /**
   * Audits go to IndexedDB, not localStorage. A 93k-row AuditState serialises
   * to tens of megabytes — far past the ~5 MB localStorage quota — so the old
   * write threw QuotaExceededError into an empty catch and "Resume last audit"
   * quietly did nothing.
   */
  const persist = useCallback((state: AuditState) => {
    void saveAudit(state).then((ok) => {
      if (ok) {
        setResumable(true);
        void pruneAudits(3);
      }
    });
  }, []);

  const note = (n: string) => setModuleNotes((prev) => (prev.includes(n) ? prev : [...prev, n]));

  /* ------------------------------------------------------------ verification */

  /**
   * Drives the verification queue: one live fetch per URL (not per issue),
   * pausable at any point, and governed by the measured Active CPU budget.
   */
  const runVerification = useCallback(
    async (
      issues: Issue[],
      auditId: string,
      opts: { collectLinks?: boolean; collectLinksUrls?: Set<string>; maxUrls?: number } = {}
    ): Promise<VerifyRunResult> => {
      const budget = budgetRef.current ?? new CpuBudget(loadBudgetConfig());
      budgetRef.current = budget;
      budget.resetRun();

      const issueById = new Map(issues.map((i) => [i.id, i]));
      // Start at zero; the real total arrives from onReady once the URL cap has
      // been applied. Seeding it with every pending issue makes the ETA count
      // work the queue will never attempt.
      setLive({ ...emptyLiveStats(), total: 0, startedAt: Date.now() });

      const queue = new VerifyQueue({
        issues,
        auditId,
        budget,
        collectLinks: opts.collectLinks ?? false,
        collectLinksUrls: opts.collectLinksUrls,
        maxUrls: opts.maxUrls ?? VERIFY_URL_CAP,
        onStatus: setQueueStatus,
        onReady: ({ urls, checks, skippedIssues }) => {
          setLive((prev) => ({ ...prev, total: checks, startedAt: Date.now() }));
          if (skippedIssues > 0) {
            note(
              `URL cap reached: verifying the top ${urls.toLocaleString()} URLs by severity ` +
                `(${checks.toLocaleString()} findings and URL checks). ${skippedIssues.toLocaleString()} lower-priority ` +
                `findings/checks are marked SKIPPED — raise VERIFY_URL_CAP in src/app/page.tsx to include them.`
            );
          }
        },
        onProgress: (done, total) => {
          setProgress(total === 0 ? 1 : done / total);
          setDetail(
            `Verifying live source · ${done.toLocaleString()}/${total.toLocaleString()} URLs · one fetch per URL · robots.txt respected`
          );
        },
        // One state update per batch instead of one per result: at 93k rows the
        // old per-result setState was tens of thousands of React renders.
        onResults: (batch: VerifyResultItem[]) => {
          setLive((prev) => {
            const next: LiveStats = {
              ...prev,
              bySeverity: { ...prev.bySeverity },
              recent: prev.recent,
            };
            const fresh: Issue[] = [];
            for (const r of batch) {
              next.done += 1;
              const src = issueById.get(r.issueId);
              if (src?.ruleId === FULL_SITE_URL_CHECK_RULE_ID) continue;
              if (r.status === "CONFIRMED") next.confirmed += 1;
              else if (r.status === "RESOLVED") next.resolved += 1;
              else if (r.status === "UNVERIFIABLE") next.unverifiable += 1;

              if (src && r.status === "CONFIRMED") {
                next.bySeverity[src.severity] += 1;
                fresh.push({ ...src, liveEvidence: r.liveEvidence, verification: r.status });
              }
            }
            if (fresh.length > 0) next.recent = [...fresh.reverse(), ...prev.recent].slice(0, 40);
            return next;
          });
        },
      });

      queueRef.current = queue;
      try {
        return await queue.run();
      } finally {
        queueRef.current = null;
        setQueueStatus(IDLE_STATUS);
      }
    },
    []
  );

  const handlePause = useCallback(() => queueRef.current?.pause(), []);
  const handleResume = useCallback(() => queueRef.current?.resume(), []);
  const handleStop = useCallback(() => queueRef.current?.stop(), []);

  const handleBudgetConfig = useCallback((config: BudgetConfig) => {
    setBudgetConfig(config);
    budgetRef.current?.setConfig(config);
  }, []);

  const handleResetLedger = useCallback(() => budgetRef.current?.resetLedger(), []);

  /* ---------------------------------------------------------------- pipeline */

  const runPipeline = useCallback(
    async (file: File) => {
      setError("");
      setPsi([]);
      setModuleNotes([]);
      const state = { ...newAudit(), gsc: auditRef.current.gsc, sitemapUrls: auditRef.current.sitemapUrls };
      state.meta.name = file.name;
      let cpuMs = 0;
      try {
        // 1 — parse
        setStage("parse");
        setProgress(-1);
        setDetail(`Stream-parsing ${file.name}…`);
        const { rows, warnings, edges, columns, fieldsPresent } = await parseCrawlFile(file, (n) =>
          setDetail(`Stream-parsing ${file.name} · ${n.toLocaleString()} rows`)
        );
        state.rows = rows;
        state.parseWarnings = warnings;
        warnings.forEach(note);
        if (edges && edges.length > 0) {
          allInlinkEdgesRef.current = edges;
          state.inlinksLoaded = true;
          state.pagerank = computePagerank(hyperlinkEdges(edges), rows);
        }

        // 2 — detect
        setStage("detect");
        setDetail(`Running detection rules across ${rows.length.toLocaleString()} URLs…`);
        await new Promise((r) => setTimeout(r, 30)); // let the UI paint
        let issues = detectIssues(rows, {
          extendedContentRules: EXTENDED_CONTENT_RULES,
          inlinkEdges: edges ?? allInlinkEdgesRef.current ?? undefined,
        });
        const uniqueUrls = new Set(issues.map((i) => i.url)).size;
        // The extended rules need the whole document, not just <head>. On a big
        // crawl that is the single largest driver of bytes fetched, so say so
        // before the queue starts rather than after the bill arrives.
        if (EXTENDED_CONTENT_RULES) {
          const extendedUrls = new Set(
            issues.filter((i) => EXTENDED_RULE_IDS.includes(i.ruleId)).map((i) => i.url)
          ).size;
          if (extendedUrls > 2_000) {
            note(
              `${extendedUrls.toLocaleString()} URLs carry an extended content finding (H2 checks), which upgrades those ` +
                `pages from a 64KB <head> read to a full-document read. Set EXTENDED_CONTENT_RULES to false in ` +
                `src/app/page.tsx to drop these rules and keep every page on the cheap tier.`
            );
          }
        }
        setDetail(
          `${issues.length.toLocaleString()} potential issues across ${uniqueUrls.toLocaleString()} URLs; ` +
            `full-site status verification will check ${new Set(rows.map((r) => r.url)).size.toLocaleString()} crawl URLs`
        );
        if (issues.length > uniqueUrls) {
          note(
            `Verification is per URL: ${issues.length.toLocaleString()} findings collapse to ${uniqueUrls.toLocaleString()} live fetches ` +
              `(${(issues.length / Math.max(1, uniqueUrls)).toFixed(1)} rules re-checked per fetch).`
          );
        }

        // 2b — cross-check against Screaming Frog's own issue counts. Runs
        // before verification so a partial/filtered export is caught before
        // the audit spends CPU verifying a crawl that was never complete.
        if (issuesOverviewRef.current) {
          try {
            const coverage = reconcileIssues(issuesOverviewRef.current, issues, rows);
            state.issuesOverview = issuesOverviewRef.current;
            state.coverage = coverage;
            for (const f of coverage.integrity) {
              if (f.severity !== "info") note(`Cross-check — ${f.title}: ${f.detail}`);
            }
            note(
              `Cross-check vs Screaming Frog: ${coverage.summary.aligned}/${coverage.summary.sfChecks} checks aligned, ` +
                `${coverage.summary.misaligned} misaligned, ${coverage.summary.buildable} derivable from this export but ` +
                `not yet ruled, ${coverage.needsExport.length} needing another export.`
            );
          } catch (e) {
            note(`Issues Overview cross-check skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        }

        const fullSiteChecks = createFullSiteUrlChecks(rows);
        issues = [...issues, ...fullSiteChecks];

        // 2c — robots pre-filter. Every URL robots.txt disallows comes back
        // UNVERIFIABLE anyway, but only after a queue slot and a round trip.
        // On a site that disallows tens of thousands of URLs that is the single
        // largest waste in the run, and it pushes real findings hours down the
        // queue. One live robots.txt fetch per origin settles it for all of them.
        try {
          const origins = new Set<string>();
          for (const i of issues) {
            try {
              origins.add(new URL(i.url).origin);
            } catch {
              /* malformed address — the concatenated-URL rule owns those */
            }
          }
          const groupsByOrigin = new Map<string, RobotsGroup[]>();
          for (const origin of [...origins].slice(0, 5)) {
            setDetail(`Reading live robots.txt for ${origin}…`);
            const res = await fetch("/api/robots", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ origin }),
            });
            if (!res.ok) continue;
            const data = (await res.json()) as { text?: string };
            const groups = parseRobotsTxt(data.text ?? "");
            if (groups.length > 0) groupsByOrigin.set(origin, groups);
          }
          if (groupsByOrigin.size > 0) {
            let blocked = 0;
            let sample = "";
            issues = issues.map((i) => {
              try {
                const u = new URL(i.url);
                const groups = groupsByOrigin.get(u.origin);
                if (!groups) return i;
                const verdict = checkRobots(groups, u.pathname + u.search);
                if (verdict.allowed) return i;
                blocked++;
                if (!sample) sample = verdict.matchedRule ?? "";
                return {
                  ...i,
                  verification: "UNVERIFIABLE" as const,
                  verifyError: `Blocked by live robots.txt (${verdict.matchedRule}) — skipped before fetching, not re-requested.`,
                };
              } catch {
                return i;
              }
            });
            if (blocked > 0) {
              const urls = new Set(
                issues.filter((i) => i.verification === "UNVERIFIABLE").map((i) => i.url)
              ).size;
              note(
                `Robots pre-filter: ${blocked.toLocaleString()} finding(s) across ${urls.toLocaleString()} URLs are ` +
                  `disallowed by the live robots.txt${sample ? ` (e.g. ${sample})` : ""}. They are marked UNVERIFIABLE ` +
                  `without a request — the fetch would have been refused anyway. Verification now runs against the ` +
                  `${(new Set(issues.filter((i) => i.verification === "PENDING").map((i) => i.url)).size).toLocaleString()} URLs that can actually be checked.`
              );
            }
          }
        } catch (e) {
          note(`Robots pre-filter skipped: ${e instanceof Error ? e.message : "failed"} — verification will fetch normally.`);
        }

        // 3 — verify (the soul)
        setStage("verify");
        setProgress(0);
        const linkHarvestUrls = new Set(
          issues.filter((i) => i.ruleId !== FULL_SITE_URL_CHECK_RULE_ID).map((i) => i.url)
        );
        const run = await runVerification(issues, state.meta.auditId, {
          collectLinks: true,
          collectLinksUrls: linkHarvestUrls,
        });
        const fullSiteResults = run.issues.filter((i) => i.ruleId === FULL_SITE_URL_CHECK_RULE_ID);
        const rowByUrl = new Map(rows.map((row) => [row.url, row]));
        const liveStatusFindings = fullSiteResults.flatMap((check) => {
          const row = rowByUrl.get(check.url);
          const finding = row ? changedLiveStatusFinding(check, row) : null;
          return finding ? [finding] : [];
        });
        const fullSiteSummary = summarizeFullSiteChecks(fullSiteResults, liveStatusFindings);
        issues = [
          ...run.issues.filter((i) => i.ruleId !== FULL_SITE_URL_CHECK_RULE_ID),
          ...liveStatusFindings,
        ];
        note(
          `Full-site live check: ${fullSiteSummary.fetched.toLocaleString()}/${fullSiteSummary.total.toLocaleString()} unique crawl URLs fetched; ` +
            `${fullSiteSummary.ok.toLocaleString()} returned 2xx, ${fullSiteSummary.redirects.toLocaleString()} redirected, ` +
            `${fullSiteSummary.clientErrors.toLocaleString()} returned 4xx, ${fullSiteSummary.serverErrors.toLocaleString()} returned 5xx, ` +
            `${fullSiteSummary.changed.toLocaleString()} new status findings, ${fullSiteSummary.unverifiable.toLocaleString()} unverifiable, ` +
            `${fullSiteSummary.skipped.toLocaleString()} skipped.`
        );
        state.headerFindings = run.headerFindings;
        cpuMs += run.cpuMs;
        if (!run.complete) {
          note(
            `Verification stopped early at ${run.verifiedPages.toLocaleString()} URLs — everything verified is in the report, ` +
              `the rest is marked SKIPPED. Active CPU spent: ${fmtCpu(run.cpuMs)}.`
          );
        }

        // 3b — link jump: chase errors found inside the live source of verified pages.
        //
        // Two things changed here. The finding is now filed with `targetUrl`
        // set to the broken URL rather than relying on `url` (which is the
        // linking page) — source tracing follows `targetUrl`, so without it the
        // report attached "pages that link to the linking page" under a heading
        // claiming to show where the broken URL came from. And the markup of the
        // offending element now rides along as evidence, because this is the one
        // moment in the pipeline where the linking page's HTML is in hand.
        const rowIndex = new UrlIndex<(typeof rows)[number]>();
        for (const r of rows) rowIndex.set(r.url, r);
        const now = new Date().toISOString();
        const jumpIssues: Issue[] = [];
        const discovered = new Map<string, { source: string; anchor: string; snippet: string }>();
        // target URL -> the live-observed links pointing at it, for source tracing.
        const liveSources = new Map<string, InlinkSource[]>();

        for (const [source, links] of run.linksBySource) {
          for (const link of links) {
            const asSource: InlinkSource = {
              url: source,
              anchor: link.anchor,
              linkType: link.linkType,
              linkPosition: link.position,
              snippet: link.snippet,
              rel: link.rel,
              follow: link.follow,
              origin: "live",
            };
            const bucket = liveSources.get(link.url) ?? [];
            bucket.push(asSource);
            liveSources.set(link.url, bucket);

            const known = rowIndex.get(link.url);
            if (known && known.statusCode >= 400) {
              jumpIssues.push({
                id: `live-broken-link::${source} -> ${link.url}`,
                ruleId: "live-broken-link",
                ruleLabel: "Live page links to a broken URL",
                severity: "High",
                owner: "Dev",
                url: source,
                targetUrl: link.url,
                evidence:
                  `Links to ${link.url} (HTTP ${known.statusCode} in the crawl) from the ${link.position} ` +
                  `area as a ${link.linkType}` +
                  (link.anchor ? `, anchor "${link.anchor}"` : "") +
                  `.\n${link.snippet}`,
                liveEvidence: `Observed in live HTML during verification: ${link.snippet}`,
                verification: "CONFIRMED",
                verifiedAt: now,
                impactScore: 0,
                fixStatus: "Open",
                sourceSamples: [asSource],
                sourceInlinkCount: 1,
                sourceByPosition: { [link.position]: 1 },
                sourceByType: { [link.linkType]: 1 },
                sourceTrace: "traced",
              });
            } else if (
              !known &&
              canonicalizeUrl(link.url) !== canonicalizeUrl(source) &&
              !discovered.has(link.url) &&
              discovered.size < 100
            ) {
              discovered.set(link.url, { source, anchor: link.anchor, snippet: link.snippet });
            }
          }
        }
        if (discovered.size > 0 && run.complete) {
          setDetail(`Link jump: live-checking ${discovered.size} URLs found in page source but absent from the crawl…`);
          setProgress(0);
          const pseudo: Issue[] = [...discovered].map(([url, found]) => ({
            id: `jump::${url}`,
            ruleId: "link-jump-check",
            ruleLabel: "Broken URL discovered via link jump",
            severity: "Critical",
            owner: "Dev",
            url,
            targetUrl: url,
            evidence:
              `Discovered in the live source of ${found.source} (not present in the crawl export)` +
              (found.anchor ? `, anchor "${found.anchor}"` : "") +
              `.\n${found.snippet}`,
            verification: "PENDING",
            impactScore: 0,
            fixStatus: "Open",
          }));
          const jumpRun = await runVerification(pseudo, `${state.meta.auditId}:jump`);
          cpuMs += jumpRun.cpuMs;
          for (const p of jumpRun.issues) {
            if (p.verification === "CONFIRMED") jumpIssues.push(p);
          }
        }
        if (jumpIssues.length > 0) {
          issues = [...issues, ...jumpIssues];
          note(`Link jump: ${jumpIssues.length} additional finding(s) from cross-checking URLs inside live page source.`);
        }

        // 4 — enrich
        setStage("enrich");
        setProgress(-1);
        let crawlHost = "";
        try {
          crawlHost = new URL(rows[0].url).hostname;
        } catch {
          /* keep empty */
        }
        const gscProperty = gscRef.current.status === "connected" ? resolveGscProperty(crawlHost) : "";
        if (state.gsc.length === 0 && gscRef.current.status === "connected") {
          const property = gscProperty;
          if (property) {
            setDetail(`Pulling Search Console data for ${property} (last 28 days)…`);
            try {
              const res = await fetch("/api/gsc/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ siteUrl: property }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `GSC query failed (${res.status})`);
              state.gsc = data.rows;
              note(`GSC auto-pulled: ${state.gsc.length.toLocaleString()} URLs with search data from ${property} (${data.window.start} → ${data.window.end}).`);
            } catch (e) {
              note(`GSC auto-pull skipped: ${e instanceof Error ? e.message : "request failed"}. CSV fallback still available.`);
            }
          } else {
            note(`GSC connected but no property matched the crawl domain "${crawlHost}" — pick one in the upload screen.`);
          }
        }
        setDetail(
          state.gsc.length > 0
            ? `Weighting impact scores with GSC data (${state.gsc.length.toLocaleString()} URLs)…`
            : "No GSC data — impact scores weighted by internal inlinks."
        );
        issues = computeImpactScores(issues, rows, state.gsc);
        state.issues = issues.sort(
          (a, b) => b.impactScore - a.impactScore || severityRank(a.severity) - severityRank(b.severity)
        );

        // 4b — error sources: for every confirmed broken URL, answer "where is
        // this coming from?" — crawl link graph first (free, offline), then the
        // GSC URL Inspection API (sitemaps + referring pages Google knows).
        try {
          state.issues = attachLiveSources(state.issues, liveSources);
          const sourceEdges = edges ?? allInlinkEdgesRef.current ?? errorInlinkEdgesRef.current;
          const trace = attachCrawlInlinkSources(state.issues, sourceEdges);
          state.issues = trace.issues;
          if (trace.traced > 0 || trace.notLinked > 0) {
            note(
              `Error sources (crawl link graph): ${trace.traced.toLocaleString()} finding(s) traced to the pages ` +
                `that link to them` +
                (trace.notLinked > 0
                  ? `; ${trace.notLinked.toLocaleString()} have no internal link pointing at them, so they are ` +
                    `reaching crawlers from a sitemap, an external site, or JavaScript the crawl did not execute`
                  : "") +
                (trace.looseMatches > 0
                  ? `; ${trace.looseMatches.toLocaleString()} matched only after normalizing case/slash/protocol`
                  : "") +
                `.`
            );
          }
          const templates = groupFixesByTemplate(state.issues);
          const template = templates.find((t) => t.position !== "Content" && t.edges >= 10);
          if (template) {
            note(
              `Fix leverage: ${template.edges.toLocaleString()} broken-link instances sit in the ${template.position} ` +
                `area across ${template.sourcePages.toLocaleString()} pages but point at only ` +
                `${template.brokenTargets.toLocaleString()} distinct URL(s) — one template change closes most of them.`
            );
          }
        } catch {
          /* best effort — sources are enrichment, never a blocker */
        }
        if (gscProperty) {
          try {
            setDetail("Tracing error sources via GSC URL Inspection (sitemaps + referring pages)…");
            setProgress(0);
            const traced = await attachGscSources(state.issues, gscProperty, GSC_INSPECT_CAP, (done, total) => {
              setProgress(total === 0 ? 1 : done / total);
              setDetail(
                `GSC URL Inspection · ${done}/${total} broken URLs traced (capped at ${GSC_INSPECT_CAP}/audit to protect the 2,000/day quota)`
              );
            });
            state.issues = traced.issues;
            if (traced.inspected > 0) {
              note(
                `Error sources: inspected ${traced.inspected} confirmed error URL(s) via GSC URL Inspection — ` +
                  `${traced.withSources} have known sitemaps/referring pages` +
                  (traced.failures > 0 ? `, ${traced.failures} inspection(s) unavailable` : "") +
                  `.`
              );
            }
          } catch (e) {
            note(`GSC error-source tracing skipped: ${e instanceof Error ? e.message : "request failed"}.`);
          }
          setProgress(-1);
        }

        // 5 — modules (each fails independently)
        setStage("modules");
        setDetail("Running power modules…");
        const allInlinkEdges = edges ?? allInlinkEdgesRef.current;
        if (!state.pagerank && allInlinkEdges) {
          try {
            state.inlinksLoaded = true;
            state.pagerank = computePagerank(hyperlinkEdges(allInlinkEdges), rows);
            note(`Module D PageRank enabled from the full All Inlinks graph (${allInlinkEdges.length.toLocaleString()} edges).`);
          } catch (e) {
            note(`Module D skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        }
        try {
          setHygiene(analyzeUrlHygiene(rows));
        } catch (e) {
          note(`Module I skipped: ${e instanceof Error ? e.message : "failed"}`);
        }
        // Module C — sitemap.
        //
        // Discovery runs automatically now: the crawl already tells us the
        // origin, robots.txt is the authoritative list of sitemaps, and asking
        // a user to paste one URL finds at most one of the eight a large site
        // publishes. Findings are emitted as real Issues so they inherit impact
        // scoring, Jira export, XLSX rows and AI explanations — previously they
        // lived in a bespoke shape visible only inside their own section.
        try {
          let sitemap = sitemapRef.current;
          if (!sitemap) {
            const origin = (() => {
              try {
                return new URL(rows[0]?.url ?? "").origin;
              } catch {
                return "";
              }
            })();
            if (origin) {
              setDetail("Discovering sitemaps from robots.txt…");
              const res = await fetch("/api/sitemap", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ origin, urls: state.sitemapUrls.length > 0 ? [] : [] }),
              });
              if (res.ok) {
                sitemap = (await res.json()) as SitemapFetchResult;
                sitemapRef.current = sitemap;
              }
            }
          }
          if (sitemap && sitemap.entries.length > 0) {
            state.sitemapUrls = sitemap.entries.map((e) => e.loc);
            state.sitemapEntries = sitemap.entries;
            state.sitemapFiles = sitemap.files;
            state.sitemapRobotsDeclared = sitemap.robotsDeclared;
            sitemap.warnings.forEach(note);

            const audit = auditSitemap({ sitemap, rows, gsc: state.gsc });
            let sitemapIssues = audit.issues;

            // URLs the crawl never saw are live-checked before being classified.
            // Calling them "potential orphans" unchecked is how a 404 sitting in
            // the sitemap used to be reported to teams as an orphan.
            if (audit.summary.unknownToCrawl.length > 0) {
              const probes = sitemapProbeIssues(audit.summary.unknownToCrawl);
              setDetail(
                `Sitemap: live-checking ${probes.length.toLocaleString()} URL(s) listed in the sitemap but absent from the crawl…`
              );
              const probeRun = await runVerification(probes, `${state.meta.auditId}:sitemap`);
              cpuMs += probeRun.cpuMs;
              sitemapIssues = [...sitemapIssues, ...probeRun.issues.filter((i) => i.verification === "CONFIRMED")];
              if (audit.summary.unknownToCrawl.length > probes.length) {
                note(
                  `${(audit.summary.unknownToCrawl.length - probes.length).toLocaleString()} further sitemap URLs were ` +
                    `absent from the crawl and not live-checked (cap reached). They are listed in Module C, unclassified.`
                );
              }
            }

            state.issues = [...state.issues, ...sitemapIssues];
            note(
              `Module C: ${audit.summary.filesFetched} sitemap file(s) fetched` +
                (audit.summary.filesFailed > 0 ? ` (${audit.summary.filesFailed} unreadable)` : "") +
                `, ${audit.summary.uniqueEntries.toLocaleString()} unique URLs, ` +
                `${sitemapIssues.length.toLocaleString()} finding(s).`
            );
            setSitemapDiff(diffSitemap(state.sitemapUrls, rows, state.gsc));
          } else {
            setSitemapDiff(null);
            note("Module C skipped: no sitemap could be discovered or fetched for this site.");
          }
        } catch (e) {
          note(`Module C skipped: ${e instanceof Error ? e.message : "failed"}`);
          setSitemapDiff(null);
        }
        if (previousAudit) {
          try {
            setDelta(computeDelta(previousAudit, state));
          } catch (e) {
            note(`Module F skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        }
        note("Module A (raw vs rendered DOM) and OAuth-based GSC modules are v2 roadmap — see README.");

        // Sitemap findings joined the issue list after scoring, so score again.
        // Re-running is idempotent and cheaper than threading a second path.
        state.issues = computeImpactScores(state.issues, rows, state.gsc).sort(
          (a, b) => b.impactScore - a.impactScore || severityRank(a.severity) - severityRank(b.severity)
        );

        // 5b — preflight. Runs unconditionally, with no optional uploads, because
        // the failure it catches (a filtered or column-poor export presented as
        // a complete audit) is invisible in the data itself. A report that states
        // its own blind spots can be forwarded to a team; one that doesn't gets a
        // verbal caveat attached by whoever forwards it.
        try {
          state.preflight = runPreflight({
            rows,
            columns: columns ?? [],
            fieldsPresent: fieldsPresent ?? [],
            issues: state.issues,
            gsc: state.gsc,
            sitemapEntries: state.sitemapEntries ?? [],
            inlinkEdges: (edges ?? allInlinkEdgesRef.current ?? errorInlinkEdgesRef.current)?.length ?? 0,
            hasIssuesOverview: Boolean(issuesOverviewRef.current),
          });
          for (const signal of state.preflight.signals) {
            if (signal.severity !== "info") note(signal.message);
          }
        } catch {
          /* preflight is advisory — never blocks a report */
        }

        // 6 — analyze (AI)
        setStage("analyze");
        const confirmed = state.issues.filter((i) => i.verification === "CONFIRMED");
        if (confirmed.length === 0) {
          setDetail("No confirmed issues — skipping AI layer.");
        } else {
          setDetail(`AI analysis: batching ${confirmed.length} confirmed issues by type…`);
          try {
            const byRule = new Map<string, Issue[]>();
            for (const i of confirmed) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);
            const groups = [...byRule.entries()].slice(0, 40).map(([ruleId, list]) => ({
              ruleId,
              ruleLabel: list[0].ruleLabel,
              severity: list[0].severity,
              count: list.length,
              sampleUrls: list.slice(0, 5).map((i) => i.url),
              sampleEvidence: list.slice(0, 5).map((i) => i.evidence.slice(0, 200)),
            }));
            const res = await fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                groups,
                siteStats: {
                  totalUrls: rows.length,
                  confirmed: confirmed.length,
                  resolved: state.issues.filter((i) => i.verification === "RESOLVED").length,
                  unverifiable: state.issues.filter((i) => i.verification === "UNVERIFIABLE").length,
                  healthScore: healthScore(state.issues, rows.length),
                },
              }),
            });
            const data = await res.json();
            if (res.ok) {
              state.analyses = data.analyses;
              state.execSummary = data.execSummary;
            } else {
              note(`AI layer skipped: ${data.error}`);
            }
          } catch (e) {
            note(`AI layer skipped: ${e instanceof Error ? e.message : "request failed"}`);
          }
        }

        // 7 — report
        state.cpuMs = cpuMs;
        note(`Active CPU spent on this audit: ${fmtCpu(cpuMs)}.`);
        setStage("report");
        setAudit(state);
        persist(state);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The pipeline failed unexpectedly.");
        setStage("upload");
      }
    },
    [persist, previousAudit, resolveGscProperty, runVerification]
  );

  const handleInlinks = useCallback(
    async (file: File, purpose: "all" | "errors") => {
      setError("");
      try {
        setDetail(purpose === "errors" ? "Parsing broken-URL source graph…" : "Parsing full link graph…");
        const parsed = await parseInlinksExport(file, (n) =>
          setDetail(`Parsing ${purpose === "errors" ? "error-source" : "full"} link graph · ${n.toLocaleString()} edges`)
        );
        const edges = parsed.edges;
        if (purpose === "errors") errorInlinkEdgesRef.current = edges;
        else allInlinkEdgesRef.current = edges;
        parsed.warnings.forEach(note);
        setAudit((prev) => {
          const next = {
            ...prev,
            inlinksLoaded: true,
            pagerank:
              purpose === "all"
                ? prev.rows.length > 0
                  ? computePagerank(hyperlinkEdges(edges), prev.rows)
                  : undefined
                : prev.pagerank,
          };
          if (prev.rows.length > 0) persist(next);
          return next;
        });
        note(
          purpose === "errors"
            ? `Broken-URL source graph loaded: ${edges.length.toLocaleString()} edges across ${
                Object.keys(parsed.byType).length
              } type(s). It will trace issue sources; PageRank continues to use the full All Inlinks graph only.`
            : edges.length >= MAX_INLINK_EDGES
              ? `Full link graph capped at ${MAX_INLINK_EDGES.toLocaleString()} edges for memory safety — PageRank runs on this sample.`
              : `Full link graph loaded: ${edges.length.toLocaleString()} edges across ${
                  Object.keys(parsed.byType).length
                } type(s) → PageRank and error-source tracing enabled.`
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Inlinks parse failed");
      }
    },
    [persist]
  );

  const handleGsc = useCallback(async (file: File) => {
    setError("");
    try {
      const rowsGsc = await parseGscPagesCsv(file);
      if (rowsGsc.length === 0) throw new Error("No page rows found in that CSV. Export Performance → Pages from Search Console.");
      setAudit((prev) => {
        const issues = prev.issues.length > 0 ? computeImpactScores(prev.issues, prev.rows, rowsGsc) : prev.issues;
        return { ...prev, gsc: rowsGsc, issues };
      });
      note(`GSC data loaded for ${rowsGsc.length.toLocaleString()} URLs → traffic-weighted impact scores.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "GSC parse failed");
    }
  }, []);

  const handleIssuesOverview = useCallback(async (file: File) => {
    setError("");
    try {
      const overview = await parseIssuesOverviewCsv(file);
      issuesOverviewRef.current = overview;
      overview.warnings.forEach(note);
      const high = overview.issues.filter((i) => i.priority === "High").length;
      note(
        `Issues Overview loaded: ${overview.issues.length} Screaming Frog checks ` +
          `(${high} high priority) → cross-check enabled. Drop the crawl file next.`
      );
      // Already have a crawl in hand? Reconcile now instead of making them re-run.
      setAudit((prev) => {
        if (prev.rows.length === 0) return prev;
        const next = { ...prev, issuesOverview: overview, coverage: reconcileIssues(overview, prev.issues, prev.rows) };
        persist(next);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Issues Overview parse failed");
    }
  }, [persist]);

  const handleSitemap = useCallback(async (url: string) => {
    setError("");
    try {
      setDetail("Fetching sitemap(s)…");
      // Pass the origin too: one pasted URL finds one sitemap, while robots.txt
      // names every sitemap the site publishes. A sitemap index is followed
      // either way.
      const origin = (() => {
        try {
          return new URL(url).origin;
        } catch {
          return undefined;
        }
      })();
      const res = await fetch("/api/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url], origin }),
      });
      const data = (await res.json()) as SitemapFetchResult & { error?: string; urls?: string[] };
      if (!res.ok) throw new Error(data.error ?? "Sitemap fetch failed");
      sitemapRef.current = data;
      setAudit((prev) => {
        const next: AuditState = {
          ...prev,
          sitemapUrls: data.entries.map((e) => e.loc),
          sitemapEntries: data.entries,
          sitemapFiles: data.files,
          sitemapRobotsDeclared: data.robotsDeclared,
        };
        if (prev.rows.length > 0) setSitemapDiff(diffSitemap(next.sitemapUrls, prev.rows, prev.gsc));
        return next;
      });
      data.warnings.forEach(note);
      const failed = data.files.filter((f) => f.kind === "unreadable");
      if (failed.length > 0) {
        note(
          `${failed.length} sitemap file(s) could not be read: ` +
            failed.slice(0, 3).map((f) => `${f.url} (${f.error})`).join("; ")
        );
      }
      note(
        `Sitemap loaded: ${data.entries.length.toLocaleString()} URLs across ${data.files.length} file(s)` +
          (data.files.some((f) => f.gzipped) ? " (gzip inflated)" : "") +
          ` → Module C enabled.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sitemap fetch failed");
    }
  }, []);

  const handlePreviousAudit = useCallback(async (file: File) => {
    setError("");
    try {
      const parsed = JSON.parse(await file.text()) as AuditState;
      if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.rows)) throw new Error("Not an AuditForge audit JSON.");
      setPreviousAudit(parsed);
      note(`Previous audit ${parsed.meta?.auditId ?? ""} loaded → delta report enabled.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read previous audit JSON.");
    }
  }, []);

  const handleFixStatus = useCallback(
    (issueId: string, status: FixStatus) => {
      setAudit((prev) => {
        const next = {
          ...prev,
          issues: prev.issues.map((i) => (i.id === issueId ? { ...i, fixStatus: status } : i)),
        };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const handleReverifyClaimed = useCallback(async () => {
    const current = auditRef.current;
    const claimed = current.issues.filter((i) => i.fixStatus === "Fixed-Claimed");
    if (claimed.length === 0) return;
    setStage("verify");
    setProgress(0);
    const reset = current.issues.map((i) =>
      i.fixStatus === "Fixed-Claimed" ? { ...i, verification: "PENDING" as const } : i
    );
    const run = await runVerification(reset, `${current.meta.auditId}:reverify`);
    const finalized = run.issues.map((i) =>
      i.fixStatus === "Fixed-Claimed"
        ? {
            ...i,
            fixStatus: (i.verification === "RESOLVED" ? "Fixed-Verified" : "Fixed-Claimed") as FixStatus,
          }
        : i
    );
    setAudit((prev) => {
      const next = {
        ...prev,
        issues: finalized,
        headerFindings: [...prev.headerFindings, ...run.headerFindings],
        cpuMs: (prev.cpuMs ?? 0) + run.cpuMs,
      };
      persist(next);
      return next;
    });
    setStage("report");
    const verified = finalized.filter((i) => i.fixStatus === "Fixed-Verified").length;
    note(`Re-verification complete: ${verified} fixes proven against live source (${fmtCpu(run.cpuMs)} Active CPU).`);
  }, [persist, runVerification]);

  const handleRunPsi = useCallback(async () => {
    setPsiError("");
    const current = auditRef.current;
    // Template clustering: first two path segments, param-stripped.
    const templates = new Map<string, string>();
    for (const r of current.rows) {
      if (r.statusCode !== 200) continue;
      try {
        const u = new URL(r.url);
        const key = u.pathname.split("/").filter(Boolean).slice(0, 2).map((s) => (/\d/.test(s) ? "*" : s)).join("/");
        if (!templates.has(key)) templates.set(key, r.url);
      } catch {
        /* skip */
      }
    }
    const samples = [...templates.values()].slice(0, 6);
    const results: PsiResult[] = [];
    for (const [idx, url] of samples.entries()) {
      setDetail(`PageSpeed Insights ${idx + 1}/${samples.length}: ${url}`);
      try {
        const res = await fetch("/api/psi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok) {
          setPsiError(data.error ?? "PSI failed");
          if (res.status === 501) return; // no key — stop entirely
          continue;
        }
        results.push(data as PsiResult);
        setPsi([...results]);
      } catch (e) {
        setPsiError(e instanceof Error ? e.message : "PSI request failed");
      }
    }
  }, []);

  const resume = useCallback(async () => {
    try {
      const parsed = await loadLatestAudit();
      if (!parsed) {
        setError("No stored audit found in this browser.");
        return;
      }
      setAudit(parsed);
      setHygiene(analyzeUrlHygiene(parsed.rows));
      if (parsed.sitemapUrls.length > 0) setSitemapDiff(diffSitemap(parsed.sitemapUrls, parsed.rows, parsed.gsc));
      setStage("report");
    } catch {
      setError("Couldn't restore the previous audit from this browser.");
    }
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl tracking-tight text-slate-100">
            Audit<span className="text-forge">Forge</span>
          </h1>
          <p className="mt-1 text-sm text-steel">
            Screaming Frog in → every issue re-verified against the live site → evidence-backed report out.
          </p>
        </div>
        {stage === "report" && (
          <button className="btn no-print" onClick={() => { setStage("upload"); setAudit(newAudit()); setDelta(null); setSitemapDiff(null); allInlinkEdgesRef.current = null; errorInlinkEdgesRef.current = null; }}>
            New audit
          </button>
        )}
      </header>

      {error && (
        <div role="alert" className="mb-6 rounded border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
          <p className="whitespace-pre-wrap">{error}</p>
          {error.includes("Apache Derby") && (
            <button
              className="btn mt-3 border-forge/60 text-forge"
              onClick={downloadConverterBat}
              title="Windows batch file: drag your .dbseospider onto it and it runs the whole conversion for you."
            >
              ⬇ Download one-click converter (.bat)
            </button>
          )}
        </div>
      )}

      {stage === "upload" && (
        <>
          {resumable && (
            <button className="btn mb-6" onClick={resume}>
              ↩ Resume last audit from this browser
            </button>
          )}
          <Upload
            busy={false}
            onCrawlFile={runPipeline}
            onInlinksFile={handleInlinks}
            onGscFile={handleGsc}
            onIssuesFile={handleIssuesOverview}
            onSitemapUrl={handleSitemap}
            onPreviousAudit={handlePreviousAudit}
            onDownloadConverter={downloadConverterBat}
            gscStatus={gscStatus}
            gscSites={gscSites}
            gscSite={gscSite}
            onGscConnect={() => (window.location.href = "/api/gsc/auth")}
            onGscSelect={handleGscSelect}
            onGscDisconnect={handleGscDisconnect}
          />
          <p className="mt-6 text-xs text-steel">
            Tip: add GSC / inlinks / sitemap / previous audit before dropping the crawl file — they&apos;re woven into the
            pipeline automatically. All parsing happens in your browser; every unique crawl URL gets a live status check,
            and URLs with findings receive deeper rule-specific verification.
          </p>
        </>
      )}

      {stage !== "upload" && (
        <div className="space-y-8">
          <Pipeline stage={stage} detail={detail} progress={progress} />
          {stage === "verify" && (
            <>
              <VerifyControls
                status={queueStatus}
                budget={budgetSnap}
                config={budgetConfig}
                onPause={handlePause}
                onResume={handleResume}
                onStop={handleStop}
                onConfigChange={handleBudgetConfig}
                onResetLedger={handleResetLedger}
              />
              <LiveFindings stats={live} />
            </>
          )}
          {stage === "report" && (
            <Report
              audit={audit}
              sitemapDiff={sitemapDiff}
              hygiene={hygiene}
              delta={delta}
              psi={psi}
              psiError={psiError}
              moduleNotes={moduleNotes}
              onFixStatus={handleFixStatus}
              onReverifyClaimed={handleReverifyClaimed}
              onRunPsi={handleRunPsi}
            />
          )}
        </div>
      )}
    </main>
  );
}