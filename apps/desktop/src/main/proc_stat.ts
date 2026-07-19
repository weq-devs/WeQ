/**
 * Tiny `/proc/<pid>/stat` reader (linux) — just enough to fingerprint a running
 * process so a recycled pid isn't mistaken for the one we injected earlier.
 *
 * The kernel recycles pids, so "pid 450411 exists" is not enough to conclude
 * "it's the same QQ we hook-injected". Field 22 of `/proc/<pid>/stat` is the
 * process start time (in clock ticks since boot); combined with the pid it is a
 * stable-enough identity for our lifetime (a boot won't preserve it, but pids
 * reset on boot too, and injected hooks die with the process anyway).
 *
 * Parsing note: field 2 (comm) is parenthesised and may itself contain spaces
 * or `)`, so we split on the LAST `)` before tokenising the rest.
 */

import { readFileSync } from 'node:fs';

/**
 * Return `/proc/<pid>/stat` field 22 (starttime) as a string, or null if the
 * process is gone / unreadable. String form avoids precision worries and is
 * only ever compared for equality.
 */
export function readProcStartTime(pid: number): string | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null; // process gone or /proc unavailable
  }
  const rparen = raw.lastIndexOf(')');
  if (rparen < 0) return null;
  // Everything after ") " is space-separated; field 3 (state) is the first
  // token there, so starttime (field 22) is index 22 - 3 = 19.
  const rest = raw.slice(rparen + 2).trim().split(/\s+/);
  const starttime = rest[19];
  return starttime ?? null;
}

/**
 * Map each pid in `pids` to its live start time, skipping any that vanished.
 * Used to prune persisted inject records against the current process table.
 */
export function readStartTimes(pids: Iterable<number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const pid of pids) {
    const st = readProcStartTime(pid);
    if (st !== null) out.set(pid, st);
  }
  return out;
}
