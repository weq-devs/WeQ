/**
 * GitHub release-download accelerators (加速站) + auto speed-test.
 *
 * Mainland-China users often can't reach github.com / its release CDN reliably,
 * so the in-app updater goes through a proxy. We race a fetch of the update
 * manifest (`latest.yml`) across every known mirror, keep the fastest healthy
 * one, and remember the full latency-sorted list for download fallback. Probing
 * the manifest path validates the whole release path shape end-to-end, so a
 * mirror that wins the race can also serve the installer that sits next to it.
 *
 * `FILE_MIRRORS` is the single source of truth — these proxies die often, so
 * this list is the ONLY place to maintain them.
 */

export const REPO = { owner: 'H3CoF6', repo: 'WeQ' } as const;

/** GitHub "latest release download" directory, proxied through each mirror. */
const GH_RELEASE_LATEST = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download`;

/** Update manifest electron-builder publishes next to the installer. */
const MANIFEST = 'latest.yml';

/**
 * Accelerator prefixes. Each is prepended to a full `https://github.com/...`
 * URL (e.g. `https://gh-proxy.com/` + `https://github.com/owner/repo/...`).
 * `''` = direct github.com — kept in the race so a user with good connectivity
 * (or a VPN) just uses the origin, and as the ultimate fallback.
 */
export const FILE_MIRRORS: readonly string[] = [
  '', // direct github.com
  'https://github.chenc.dev/',
  'https://ghproxy.cfd/',
  'https://github.tbedu.top/',
  'https://ghproxy.cc/',
  'https://gh.monlor.com/',
  'https://cdn.akaere.online/',
  'https://gh.idayer.com/',
  'https://gh.llkk.cc/',
  'https://ghpxy.hwinzniej.top/',
  'https://github-proxy.memory-echoes.cn/',
  'https://git.yylx.win/',
  'https://gitproxy.mrhjx.cn/',
  'https://gh.fhjhy.top/',
  'https://gp.zkitefly.eu.org/',
  'https://gh-proxy.com/',
  'https://ghfile.geekertao.top/',
  'https://j.1lin.dpdns.org/',
  'https://ghproxy.imciel.com/',
  'https://github-proxy.teach-english.tech/',
  'https://gh.927223.xyz/',
  'https://github.ednovas.xyz/',
  'https://ghf.xn--eqrr82bzpe.top/',
  'https://gh.dpik.top/',
  'https://gh.jasonzeng.dev/',
  'https://gh.xxooo.cf/',
  'https://gh.bugdey.us.kg/',
  'https://ghm.078465.xyz/',
  'https://j.1win.ggff.net/',
  'https://tvv.tw/',
  'https://gitproxy.127731.xyz/',
  'https://gh.inkchills.cn/',
  'https://ghproxy.cxkpro.top/',
  'https://gh.sixyin.com/',
  'https://github.geekery.cn/',
  'https://git.669966.xyz/',
  'https://gh.5050net.cn/',
  'https://gh.felicity.ac.cn/',
  'https://github.dpik.top/',
  'https://ghp.keleyaa.com/',
  'https://gh.wsmdn.dpdns.org/',
  'https://ghproxy.monkeyray.net/',
  'https://fastgit.cc/',
  'https://gh.catmak.name/',
  'https://gh.noki.icu/',
];

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
}

export interface BestMirror {
  /** Fastest healthy release base. */
  base: string;
  /** Version from the fastest mirror's latest.yml. */
  version: string;
  /** Every healthy release base, fastest first (download fallback order). */
  ranked: string[];
}

const VERSION_RE = /^version:\s*(.+)$/m;

/** Fetch + validate one mirror's latest.yml, timing it. Rejects on any failure. */
async function probe(prefix: string, timeoutMs: number): Promise<MirrorProbe> {
  const base = releaseBase(prefix);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    // undici (Node fetch) keeps no HTTP cache, so no `cache: 'no-store'` needed.
    const res = await fetch(`${base}/${MANIFEST}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = VERSION_RE.exec(text);
    const version = m?.[1]?.trim();
    if (!version) throw new Error('manifest has no version');
    return { base, version, ms: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race latest.yml across all mirrors. Returns the fastest healthy mirror plus a
 * latency-sorted list of every healthy one. Throws if none respond in time.
 */
export async function resolveBestMirror(timeoutMs = 4000): Promise<BestMirror> {
  const settled = await Promise.allSettled(FILE_MIRRORS.map((p) => probe(p, timeoutMs)));
  const ok = settled
    .filter((r): r is PromiseFulfilledResult<MirrorProbe> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => a.ms - b.ms);

  const best = ok[0];
  if (!best) throw new Error('无法连接更新服务器（所有加速站均不可用，请检查网络）');

  return { base: best.base, version: best.version, ranked: ok.map((p) => p.base) };
}
