import { randomUUID } from "node:crypto";

/**
 * Active CPU metering for Vercel Fluid compute.
 *
 * Fluid bills three axes; the one that bites this app is **Active CPU** — the
 * time your code actually holds the CPU. I/O waits (fetch, sleep) are not
 * billed. `process.cpuUsage()` measures exactly that: user + system
 * microseconds for this process.
 *
 * The subtlety: under Fluid, a single instance serves many concurrent
 * invocations, and `process.cpuUsage()` is process-wide. A per-request delta
 * would therefore count work done for a sibling request that happened to
 * overlap — inflating the number, sometimes several-fold.
 *
 * So we report the instance's *cumulative* counter alongside a boot-scoped id.
 * The client keeps `max(cumulative)` per instance id and sums across instances.
 * That total is exact no matter how requests interleave, because every ms of
 * CPU this instance ever burns is counted once, by the last request to see it.
 */
export const INSTANCE_ID = randomUUID();

export interface CpuMeterReading {
  instanceId: string;
  /** Cumulative Active CPU burned by this instance since boot, in ms. Authoritative. */
  instanceCpuMs: number;
  /** CPU attributable to this request. Inflated under concurrency — display only. */
  requestCpuMs: number;
  /** Wall-clock duration. Drives Provisioned Memory (GB-hr), not Active CPU. */
  wallMs: number;
}

/**
 * Call at the top of a route handler; call the returned function just before
 * responding and put the reading in the response body.
 */
export function startMeter(): () => CpuMeterReading {
  const requestStart = process.cpuUsage();
  const wallStart = Date.now();

  return () => {
    const delta = process.cpuUsage(requestStart);
    const cumulative = process.cpuUsage();
    return {
      instanceId: INSTANCE_ID,
      instanceCpuMs: Math.round((cumulative.user + cumulative.system) / 1000),
      requestCpuMs: Math.round((delta.user + delta.system) / 1000),
      wallMs: Date.now() - wallStart,
    };
  };
}
