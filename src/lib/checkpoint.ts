"use client";
import { AuditState, VerifyResultItem } from "@/lib/schema";

/**
 * Durable client-side state: verification checkpoints and finished audits.
 *
 * The old resume path wrote the entire AuditState to localStorage. At 93k rows
 * that JSON is tens of megabytes, so `setItem` threw QuotaExceededError, the
 * empty catch swallowed it, and "Resume last audit" silently did nothing —
 * exactly when resuming mattered most.
 *
 * IndexedDB has no practical size ceiling here and stores structured values
 * without a stringify pass, so persisting costs almost nothing. Checkpoints are
 * written every few batches and on every pause, so a refresh mid-run loses
 * seconds of work rather than hours of CPU you have already paid for.
 */

const DB_NAME = "auditforge";
const DB_VERSION = 1;
const CHECKPOINTS = "verify-checkpoints";
const AUDITS = "audits";

export interface VerifyCheckpoint {
  auditId: string;
  updatedAt: number;
  label: string;
  /** URLs still to verify, in priority order. */
  queue: { url: string; checks: { issueId: string; ruleId: string; crawlEvidence: string }[] }[];
  /** Index of the next queue entry to dispatch. */
  cursor: number;
  /** Results collected so far, keyed by issueId. */
  results: Record<string, VerifyResultItem>;
  /** Same-origin links harvested from live HTML, for the link-jump pass. */
  linksBySource: Record<string, string[]>;
  /** Active CPU this run has spent so far, in ms. */
  runCpuMs: number;
}

export interface StoredAudit {
  auditId: string;
  updatedAt: number;
  state: AuditState;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable in this browser context"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHECKPOINTS)) db.createObjectStore(CHECKPOINTS, { keyPath: "auditId" });
      if (!db.objectStoreNames.contains(AUDITS)) db.createObjectStore(AUDITS, { keyPath: "auditId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const req = fn(transaction.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
        transaction.oncomplete = () => db.close();
      })
  );
}

/* ------------------------------- checkpoints ------------------------------ */

export async function saveCheckpoint(cp: VerifyCheckpoint): Promise<void> {
  try {
    await tx(CHECKPOINTS, "readwrite", (s) => s.put({ ...cp, updatedAt: Date.now() }));
  } catch {
    /* checkpointing is an optimisation; never let it break a run */
  }
}

export async function loadCheckpoint(auditId: string): Promise<VerifyCheckpoint | null> {
  try {
    return (await tx<VerifyCheckpoint | undefined>(CHECKPOINTS, "readonly", (s) => s.get(auditId))) ?? null;
  } catch {
    return null;
  }
}

export async function listCheckpoints(): Promise<VerifyCheckpoint[]> {
  try {
    const all = await tx<VerifyCheckpoint[]>(CHECKPOINTS, "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function clearCheckpoint(auditId: string): Promise<void> {
  try {
    await tx(CHECKPOINTS, "readwrite", (s) => s.delete(auditId));
  } catch {
    /* best effort */
  }
}

/* --------------------------------- audits --------------------------------- */

export async function saveAudit(state: AuditState): Promise<boolean> {
  try {
    await tx(AUDITS, "readwrite", (s) =>
      s.put({ auditId: state.meta.auditId, updatedAt: Date.now(), state } satisfies StoredAudit)
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadLatestAudit(): Promise<AuditState | null> {
  try {
    const all = await tx<StoredAudit[]>(AUDITS, "readonly", (s) => s.getAll());
    if (all.length === 0) return null;
    return all.sort((a, b) => b.updatedAt - a.updatedAt)[0].state;
  } catch {
    return null;
  }
}

export async function hasStoredAudit(): Promise<boolean> {
  try {
    const count = await tx<number>(AUDITS, "readonly", (s) => s.count());
    return count > 0;
  } catch {
    return false;
  }
}

/** Keeps the most recent `keep` audits and drops the rest. */
export async function pruneAudits(keep = 3): Promise<void> {
  try {
    const all = await tx<StoredAudit[]>(AUDITS, "readonly", (s) => s.getAll());
    const stale = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(keep);
    for (const audit of stale) {
      await tx(AUDITS, "readwrite", (s) => s.delete(audit.auditId));
    }
  } catch {
    /* best effort */
  }
}
