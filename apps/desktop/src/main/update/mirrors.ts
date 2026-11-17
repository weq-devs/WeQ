import { networkFetch } from '@weq/network';
/**
 * GitHub release-download accelerators (加速站) + auto speed-test.
 *
 * Mainland-China users often can't reach github.com / its release CDN reliably,
 * so the in-app updater goes through a proxy.
 *
 * Mirror selection is deliberately TWO-PHASE, because fetching the tiny manifest
 * only measures latency/health — NOT download bandwidth, and the two often
 * disagree (measured on the same day: a 651ms mirror served 0.46 MB/s while a
 * 1329ms mirror served 0.76 MB/s):
 *
 *   1. SCREEN — race `latest.yml` across every mirror with a short timeout. This
 *      validates the whole release path shape end-to-end (wrong manifest name =
 *      404 everywhere) and drops dead / rate-limited / blocked mirrors early.
 *   2. RANK   — take the fastest few survivors and race a real ranged GET of the
 *      installer itself, measuring bytes/sec. Sort by that.
 *
 * The winner is the fastest *by measured bandwidth*; the rest of the healthy
 * list stays as download fallback order. When no mirror can be speed-measured
 * (e.g. a proxy strips `Range`), the phase-1 latency order is the fallback.
 *
 * The manifest filename is platform/arch-specific — electron-builder publishes
 * `latest.yml` (Windows), `latest-mac.yml` (macOS), `latest-linux.yml` (Linux
 * x64) and `latest-linux-arm64.yml` (Linux arm64). Probing the wrong name 404s
 * on every mirror, which is exactly why Linux never saw updates before.
 *
 * `FILE_MIRRORS` is the single source of truth — these proxies die often, so
 * this list is the ONLY place to maintain them.
 */

import semver from 'semver';
import { resolveUpdateRelease } from './releases';
import { orderSources, recordSourceHealth } from '@weq/network';

export const REPO = { owner: 'weq-devs', repo: 'WeQ' } as const;

/** GitHub "latest release download" directory, proxied through each mirror. */
const GH_RELEASE_LATEST = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download`;

/**
 * Update manifest electron-builder publishes next to the installer. The name
 * depends on the running platform/arch — see the module header. Windows =
 * `latest.yml`, macOS = `latest-mac.yml`, Linux x64 = `latest-linux.yml`,
 * Linux arm64 = `latest-linux-arm64.yml`.
 */
function manifestName(): string {
  if (process.platform === 'win32') return 'latest.yml';
  if (process.platform === 'darwin') return 'latest-mac.yml';
  // linux (and any other posix): electron-builder suffixes arm64 explicitly.
  return process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
}

const MANIFEST = manifestName();

/**
 * Accelerator prefixes. Each is prepended to a full `https://github.com/...`
 * URL (e.g. `https://gh-proxy.com/` + `https://github.com/owner/repo/...`).
 * `''` = direct github.com — kept in the race so a user with good connectivity
 * (or a VPN) just uses the origin, and as the ultimate fallback.
 */
export { FILE_MIRRORS } from '@weq/network/mirrors';
import { FILE_MIRRORS } from '@weq/network/mirrors';

/** Release base URL (the updater feed directory) for a mirror prefix. */
export function releaseBase(prefix: string): string {
  return `${prefix}${GH_RELEASE_LATEST}`;
}

interface MirrorProbe {
  /** Release base, e.g. `<prefix>https://github.com/.../releases/latest/download`. */
  base: string;
  /** Time to fetch latest.yml, in ms (lower = faster). */
  ms: number;
  /** Version parsed from that mirror's latest.yml. */
  version: string;
  /** Installer filename parsed from latest.yml's `path:` (for the bandwidth probe). */
  fileName: string;
}

export interface BestMirror {
  channel?: string;
  /** Fastest healthy release base (by measured bandwidth when available). */
  base: string;
  /** Version parsed from that mirror's latest.yml. */
  version: string;
  /** Every healthy release base, best first (download fallback order). */
  ranked: string[];
}

const VERSION_RE = /^version:\s*(.+)$/m;
const PATH_RE = /^path:\s*(.+)$/m;

/**
 * Resolve with the first `n` *fulfilled* results out of `promises`, ignoring
 * rejections (dead mirrors usually fail fast anyway, but we don't want them to
 * count toward the quota). Used to overlap Phase 2 with Phase 1's slow tail:
 * the early healthy responders get speed-probed while stragglers are still
 * timing out.
 *
 * MUST also resolve once every promise has settled, otherwise a run with fewer
 * than `n` healthy mirrors would wait forever — `allSettled` is the escape
 * hatch that guarantees termination.
 */
function firstNFulfilled<T>(promises: Promise<T>[], n: number): Promise<T[]> {
  const results: T[] = [];
  return new Promise((resolve) => {
    let remaining = n;
    let pending = promises.length;
    const settle = (): void => resolve(results);
    for (const p of promises) {
      void p.then(
        (value) => {
          results.push(value);
          pending--;
          if (--remaining === 0 || pending === 0) settle();
        },
        () => {
          pending--;
          if (remaining === 0 || pending === 0) settle();
        },
      );
    }
    if (pending === 0) settle();
  });
}

/** How long the manifest screen lets each mirror take before giving up. */
const SCREEN_TIMEOUT_MS = 4000;
/** How many of the fastest survivors get a real bandwidth probe. */
const SPEED_PROBE_COUNT = 3;
/** Bytes to pull per speed probe — enough to smooth TCP ramp-up, small enough to stay quick. */
const SPEED_PROBE_BYTES = 1_000_000;
/** Hard cap on each bandwidth probe. */
const SPEED_TIMEOUT_MS = 6000;

/** Fetch + validate one mirror's latest.yml, timing it. Rejects on any failure. */
async function probe(
  prefix: string,
  timeoutMs: number,
  release: Awaited<ReturnType<typeof resolveUpdateRelease>>,
): Promise<MirrorProbe> {
  const base = `${prefix}https://github.com/${REPO.owner}/${REPO.repo}/releases/download/${encodeURIComponent(release.tag)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    // undici (Node fetch) keeps no HTTP cache, so no `cache: 'no-store'` needed.
    const res = await networkFetch(`${base}/${release.manifest}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = VERSION_RE.exec(text);
    const version = m?.[1]?.trim();
    if (!version) throw new Error('manifest has no version');
    if (!semver.valid(version) || !semver.eq(version, release.version))
      throw new Error('更新清单与已选择发布的版本不一致');
    const p = PATH_RE.exec(text);
    const fileName = p?.[1]?.trim();
    if (!fileName) throw new Error('manifest has no path');
    return { base, version, fileName, ms: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Measured download speed for one mirror, in bytes/sec, by pulling a ranged
 * slice of the *installer* (same release base as the manifest, so the URL that
 * wins here is the URL the updater will actually fetch). Returns null when the
 * mirror can't serve a ranged chunk — the caller then falls back to latency.
 *
 * `Range` also sidesteps the proxy that omits `content-length` behind gzip: a
 * ranged response is `206` with a real length, rather than an indeterminate
 * gzip stream that would kill the progress bar.
 */
async function measureBandwidth(base: string, fileName: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SPEED_TIMEOUT_MS);
  const t0 = performance.now();
  let bytes = 0;
  try {
    const res = await networkFetch(`${base}/${fileName}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { range: `bytes=0-${SPEED_PROBE_BYTES - 1}`, 'cache-control': 'no-cache' },
    });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes >= SPEED_PROBE_BYTES) break;
    }
    const seconds = (performance.now() - t0) / 1000;
    // Ignore degenerate samples (server ignored Range and sent headers only).
    if (bytes < SPEED_PROBE_BYTES / 4 || seconds <= 0) return null;
    return bytes / seconds;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * Two-phase mirror selection: screen `latest.yml` everywhere, then rank the
 * fastest few by real download bandwidth. Throws if no mirror is reachable.
 */
export async function resolveBestMirror(
  timeoutMs = SCREEN_TIMEOUT_MS,
  includePrerelease = false,
  sample = true,
): Promise<BestMirror> {
  const release = await resolveUpdateRelease(includePrerelease, MANIFEST);
  // Phase 1: screen every mirror. Most of the wall-clock cost is the slow tail
  // (dead mirrors burning the full timeout), so we start Phase 2 as soon as the
  // first SPEED_PROBE_COUNT mirrors have answered — bandwidth probing then
  // overlaps with the stragglers instead of queuing behind them.
  const ordered = orderSources(
    FILE_MIRRORS.map(
      (prefix) =>
        `${prefix}https://github.com/${REPO.owner}/${REPO.repo}/releases/download/${encodeURIComponent(release.tag)}`,
    ),
  );
  const deadline = Date.now() + 20000;
  const probes: Promise<MirrorProbe>[] = [];
  for (let index = 0; index < ordered.length && Date.now() < deadline; index += 3) {
    const batch = ordered.slice(index, index + 3).map((base) => {
      const prefix = base.slice(0, base.indexOf('https://github.com/'));
      const work = probe(prefix, Math.min(timeoutMs, Math.max(1, deadline - Date.now())), release);
      void work.then(
        (result) => recordSourceHealth(result.base, true),
        () => recordSourceHealth(base, false),
      );
      return work;
    });
    probes.push(...batch);
    if ((await Promise.allSettled(batch)).some((item) => item.status === 'fulfilled')) break;
  }
  const earlyOk = (await firstNFulfilled(probes, SPEED_PROBE_COUNT)).sort((a, b) => a.ms - b.ms);
  // Kick off bandwidth probes now; they keep running while the tail settles.
  const earlyCandidates = earlyOk.slice(0, SPEED_PROBE_COUNT);
  const earlySpeeds = Promise.all(
    earlyCandidates.map((c) =>
      sample ? measureBandwidth(c.base, c.fileName) : Promise.resolve(null),
    ),
  );

  // Now wait for the rest of Phase 1 so the fallback list stays complete.
  const settled = await Promise.allSettled(probes);
  const ok = settled
    .filter((r): r is PromiseFulfilledResult<MirrorProbe> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => a.ms - b.ms);

  const winner = ok[0];
  if (!winner) throw new Error('无法连接更新服务器（所有加速站均不可用，请检查网络）');

  // Phase 2 results. Only the probe uses the installer URL; the winner's feed
  // is still its release base (electron-updater joins base + fileName itself).
  const candidates = ok.slice(0, SPEED_PROBE_COUNT);
  const earlyBps = await earlySpeeds;
  const speeds = candidates.map((c) => {
    const i = earlyCandidates.findIndex((e) => e.base === c.base);
    if (i === -1) return sample ? measureBandwidth(c.base, c.fileName) : Promise.resolve(null);
    return Promise.resolve(earlyBps[i] ?? null);
  });
  const measuredSpeeds = await Promise.all(speeds);
  const latencyOrder = ok.map((p) => p.base);
  const measured = candidates
    .map((c, i) => ({ base: c.base, bps: measuredSpeeds[i] }))
    .filter((x): x is { base: string; bps: number } => x.bps != null)
    .sort((a, b) => b.bps - a.bps)
    .map((x) => x.base);
  const measuredSet = new Set(measured);
  const probedSet = new Set(candidates.map((c) => c.base));

  // No usable measurements (everything stripped Range / timed out): keep the
  // phase-1 latency order rather than demoting the mirrors we couldn't probe.
  // Otherwise: measured-fastest first, unprobed mirrors keep their latency
  // order, and probed mirrors whose measurement failed sink to the very end
  // rather than silently keeping a latency rank a real transfer didn't earn.
  const ranked =
    measured.length === 0
      ? latencyOrder
      : [
          ...measured,
          ...latencyOrder.filter((b) => !probedSet.has(b)),
          ...candidates.map((c) => c.base).filter((b) => !measuredSet.has(b)),
        ];
  // 未在冷启动探测的源留作实际下载失败后的候选，不为检查更新预拉所有站点。
  ranked.push(...orderSources(ordered).filter((base) => !ranked.includes(base)));

  // `ranked` always contains every healthy base, and `ok` is non-empty here, so
  // the fallback only exists to satisfy the type checker.
  return {
    base: ranked[0] ?? winner.base,
    version: release.version,
    ranked,
    channel: release.channel,
  };
}
