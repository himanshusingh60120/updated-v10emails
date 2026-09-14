"use client";
import { useEffect, useState } from "react";

/**
 * Holds a Screen Wake Lock while a long verification run is in progress.
 *
 * What this does and doesn't do, precisely — because the difference decides
 * whether a 40-minute local run survives:
 *
 *   ✓ Stops the display sleeping, which on most default power plans is what
 *     triggers system sleep a few minutes later.
 *   ✓ Keeps the tab foregrounded and unthrottled, so the queue's timers keep
 *     firing at full rate.
 *   ✗ Does NOT stop a lid close, an explicit sleep, or a system sleep timer.
 *     Nothing in a browser can. For unattended runs use an OS-level inhibitor
 *     (caffeinate / systemd-inhibit / powercfg) as well — see RUNNING-LOCALLY.md.
 *
 * The lock is released by the browser whenever the tab is hidden, so it has to
 * be re-acquired on every visibilitychange. That re-acquisition is the part
 * most implementations forget.
 */
export function useWakeLock(active: boolean): { held: boolean; supported: boolean } {
  const [held, setHeld] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "wakeLock" in navigator);
  }, []);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      setHeld(false);
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
        setHeld(true);
        sentinel.addEventListener("release", () => setHeld(false));
      } catch {
        // Denied (usually: tab not visible, or battery saver). Not fatal —
        // the run continues, it just won't hold the screen on.
        setHeld(false);
      }
    };

    // The browser drops the lock on tab hide; take it back on return.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
      setHeld(false);
    };
  }, [active]);

  return { held, supported };
}
