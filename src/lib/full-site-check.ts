import { CrawlRow, Issue } from "./schema";

export const FULL_SITE_URL_CHECK_RULE_ID = "full-site-url-check";

export interface FullSiteCheckSummary {
  total: number;
  fetched: number;
  ok: number;
  redirects: number;
  clientErrors: number;
  serverErrors: number;
  unverifiable: number;
  skipped: number;
  changed: number;
}

export function createFullSiteUrlChecks(rows: CrawlRow[]): Issue[] {
  const uniqueRows = new Map(rows.map((row) => [row.url, row]));
  return [...uniqueRows.values()].map((row) => ({
    id: `${FULL_SITE_URL_CHECK_RULE_ID}::${row.url}`,
    ruleId: FULL_SITE_URL_CHECK_RULE_ID,
    ruleLabel: "Full-site live URL check",
    severity: "Low",
    owner: "Dev",
    url: row.url,
    evidence: `Crawl recorded HTTP ${row.statusCode}`,
    verification: "PENDING",
    impactScore: 0,
    fixStatus: "Open",
  }));
}

export function changedLiveStatusFinding(check: Issue, row: CrawlRow): Issue | null {
  if (check.verification !== "CONFIRMED") return null;
  const liveStatus = Number.parseInt(check.liveEvidence?.match(/Live HTTP\s+(\d{3})/i)?.[1] ?? "", 10);
  if (!Number.isFinite(liveStatus)) return null;
  const wasRedirected = /; redirect chain:/i.test(check.liveEvidence ?? "");
  const changed =
    (liveStatus >= 400 && liveStatus !== row.statusCode) ||
    (row.statusCode === 200 && (liveStatus >= 300 || wasRedirected)) ||
    (liveStatus >= 300 && liveStatus < 400 && liveStatus !== row.statusCode);
  if (!changed) return null;

  const ruleId = liveStatus >= 500 ? "http-5xx" : liveStatus >= 400 ? "http-4xx" : "live-status-changed";
  const ruleLabel =
    ruleId === "http-5xx"
      ? "5xx server error"
      : ruleId === "http-4xx"
        ? "4xx client error"
        : "Live URL status changed since crawl";
  const severity =
    liveStatus === 410 ? "High" : liveStatus >= 400 ? "Critical" : "Medium";
  return {
    ...check,
    id: `${ruleId}::${row.url}`,
    ruleId,
    ruleLabel,
    severity,
    evidence: `Crawl export recorded HTTP ${row.statusCode}`,
    liveEvidence: check.liveEvidence,
    verification: "CONFIRMED",
    owner: "Dev",
    impactScore: 0,
    fixStatus: "Open",
  };
}

export function summarizeFullSiteChecks(checks: Issue[], changed: Issue[]): FullSiteCheckSummary {
  const summary: FullSiteCheckSummary = {
    total: checks.length,
    fetched: 0,
    ok: 0,
    redirects: 0,
    clientErrors: 0,
    serverErrors: 0,
    unverifiable: 0,
    skipped: 0,
    changed: changed.length,
  };

  for (const check of checks) {
    if (check.verification === "UNVERIFIABLE") {
      summary.unverifiable++;
      continue;
    }
    if (check.verification === "SKIPPED") {
      summary.skipped++;
      continue;
    }
    if (check.verification !== "CONFIRMED") continue;

    summary.fetched++;
    const liveStatus = Number.parseInt(check.liveEvidence?.match(/Live HTTP\s+(\d{3})/i)?.[1] ?? "", 10);
    if (!Number.isFinite(liveStatus)) continue;
    if (liveStatus >= 500) summary.serverErrors++;
    else if (liveStatus >= 400) summary.clientErrors++;
    else if (liveStatus >= 300 || /; redirect chain:/i.test(check.liveEvidence ?? "")) summary.redirects++;
    else if (liveStatus >= 200) summary.ok++;
  }
  return summary;
}
