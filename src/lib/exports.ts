"use client";
import { AuditState, InlinkSource, Issue, severityRank } from "./schema";
import { confidenceVerdict } from "./preflight";
import { ERROR_SOURCE_RULES, groupFixesByTemplate, tracedUrl } from "./sources";

export function downloadText(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Source columns are split out rather than joined into one newline-delimited
 * cell. Teams consume these sheets by filtering and pivoting — "show me every
 * 404 whose links live in the footer" has to be a filter, not a text search.
 */
function issueRows(issues: Issue[]): Record<string, string | number>[] {
  return issues.map((i) => {
    const top = (i.sourceSamples ?? [])[0];
    const positions = Object.entries(i.sourceByPosition ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([pos, n]) => `${pos}: ${n}`)
      .join(", ");
    return {
      URL: i.url,
      "Broken URL": i.targetUrl ?? "",
      Issue: i.ruleLabel,
      Severity: i.severity,
      "Impact Score": i.impactScore,
      Verification: i.verification,
      "Verified At": i.verifiedAt ?? "",
      "Crawl Evidence": i.evidence,
      "Live Evidence": i.liveEvidence ?? "",
      "Verify Error": i.verifyError ?? "",
      Owner: i.owner,
      "Fix Status": i.fixStatus,
      "GSC Clicks": i.gscClicks ?? "",
      "GSC Impressions": i.gscImpressions ?? "",
      "GSC Coverage": i.gscCoverageState ?? "",
      "Source Trace": i.sourceTrace ?? "",
      "Source Count": i.sourceInlinkCount ?? "",
      "Source Positions": positions,
      "Source Types": Object.entries(i.sourceByType ?? {})
        .map(([t, n]) => `${t}: ${n}`)
        .join(", "),
      "Top Source URL": top?.url ?? "",
      "Top Source Anchor": top?.anchor ?? "",
      "Top Source Position": top?.linkPosition ?? "",
      "Top Source XPath": top?.linkPath ?? "",
      "Top Source Markup": top?.snippet ?? "",
      "Source: Sitemaps (GSC)": (i.sourceSitemaps ?? []).join("\n"),
      "Source: Referring Pages (GSC)": (i.sourceReferringPages ?? []).join("\n"),
      "Source: Internal Inlinks (crawl)": (i.sourceInternalInlinks ?? []).join("\n"),
    };
  });
}

/** One row per traced edge — the tab a developer actually works from. */
function sourceRows(issues: Issue[]): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [];
  for (const i of issues) {
    if (!ERROR_SOURCE_RULES.has(i.ruleId)) continue;
    for (const s of i.sourceSamples ?? []) {
      out.push({
        "Broken URL": tracedUrl(i),
        Issue: i.ruleLabel,
        Severity: i.severity,
        "Linking Page": s.url,
        "Link Type": s.linkType,
        "Link Position": s.linkPosition,
        Anchor: s.anchor,
        XPath: s.linkPath ?? "",
        Markup: s.snippet ?? "",
        Rel: s.rel ?? "",
        Follow: s.follow === undefined ? "" : String(s.follow),
        "Evidence Origin": s.origin,
        Owner: i.owner,
        "Fix Status": i.fixStatus,
      });
    }
  }
  return out;
}

/** One workbook: Master sheet + one sheet per issue type. */
export async function exportXlsx(audit: AuditState): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const sorted = [...audit.issues].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.impactScore - a.impactScore
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows(sorted)), "Master");

  const byRule = new Map<string, Issue[]>();
  for (const i of sorted) {
    const list = byRule.get(i.ruleId) ?? [];
    list.push(i);
    byRule.set(i.ruleId, list);
  }
  for (const [ruleId, list] of byRule) {
    const name = ruleId.slice(0, 31).replace(/[[\]*/\\?:]/g, "-");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows(list)), name);
  }
  // Sources sheet: one row per edge, so "which pages link to this 404" is a
  // filterable table rather than a wrapped cell inside the Master sheet.
  const sources = sourceRows(sorted);
  if (sources.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sources), "Sources");
  }

  // Fix-by-template: the sprint-planning view. A footer link repeated across
  // 412 pages is one ticket, and only this grouping makes that visible.
  const templates = groupFixesByTemplate(sorted);
  if (templates.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        templates.map((t) => ({
          "Page Area": t.position,
          "Link Instances": t.edges,
          "Distinct Broken URLs": t.brokenTargets,
          "Source Pages Affected": t.sourcePages,
          "Example Broken URL": t.sampleTarget,
          "Example Anchor": t.sampleAnchor,
          "Example XPath": t.sampleXPath ?? "",
        }))
      ),
      "Fix by template"
    );
  }

  // Confidence sheet: what was checked, what could not be, and why. This is what
  // makes the workbook safe to forward without a verbal caveat attached.
  if (audit.preflight) {
    const p = audit.preflight;
    const rows: Record<string, string | number>[] = [
      { Item: "Confidence", Detail: `${p.confidence}/100`, Note: confidenceVerdict(p) },
      { Item: "Crawl rows", Detail: p.inputs.crawlRows, Note: "" },
      { Item: "Link graph edges", Detail: p.inputs.inlinkEdges, Note: p.inputs.inlinkEdges === 0 ? "No source tracing possible" : "" },
      { Item: "GSC rows", Detail: p.inputs.gscRows, Note: "" },
      { Item: "Sitemap URLs", Detail: p.inputs.sitemapEntries, Note: "" },
      { Item: "Issues Overview", Detail: p.inputs.issuesOverview ? "supplied" : "absent", Note: "" },
    ];
    for (const c of p.ruleCoverage) {
      rows.push({
        Item: `Checks: ${c.label}`,
        Detail: c.readiness,
        Note: c.missing.length > 0 ? `Missing column(s): ${c.missing.join(", ")}` : "",
      });
    }
    for (const sig of p.signals) {
      rows.push({ Item: `Signal (${sig.severity})`, Detail: sig.id, Note: sig.message });
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Report confidence");
  }

  if (audit.headerFindings.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        audit.headerFindings.map((h) => ({ URL: h.url, Check: h.check, Grade: h.grade, Detail: h.detail }))
      ),
      "Header audit"
    );
  }
  XLSX.writeFile(wb, `auditforge-${audit.meta.auditId}.xlsx`);
}

export function exportAuditJson(audit: AuditState): void {
  downloadText(`auditforge-${audit.meta.auditId}.json`, JSON.stringify(audit), "application/json");
}