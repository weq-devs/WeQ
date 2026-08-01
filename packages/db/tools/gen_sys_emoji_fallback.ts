/**
 * 生成 `packages/service/src/account/sys_emoji_fallback.ts` —— 内置表情资源地址的
 * 兜底表，供 emoji.db 缺失 / `base_sys_emoji_table` 为空的环境使用。
 *
 * 需要一份有数据的 emoji.db（走 @weq/testkit 的 .env 配置）。腾讯更新内置表情后
 * 可以重跑本脚本刷新兜底表。
 *
 * 用法:
 *   pnpm tsx packages/db/tools/gen_sys_emoji_fallback.ts > packages/service/src/account/sys_emoji_fallback.ts
 *   npx biome format --write packages/service/src/account/sys_emoji_fallback.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '@weq/testkit';

const KEY = testEnv.key;
const P = qqDbPath('emoji.db');
const RE =
  /^(https:\/\/wa\.qq\.com\/qgif-web-permanent\/(?:test\/)?sysemoji\/v\d\/singleres)\/(.+)_adv_(\d+)\.zip$/;

class Raw extends QqDb {
  q(s: string) {
    return this.query(s);
  }
}

async function main() {
  const { ntHelper } = loadNative();
  const probe = await ntHelper.testDatabaseKey(P, KEY);
  const db = new Raw(ntHelper, {
    dbPath: P,
    key: KEY,
    algo: {
      pageHmacAlgorithm: probe.pageHmacAlgorithm!,
      kdfHmacAlgorithm: probe.kdfHmacAlgorithm!,
    },
  });

  const rows = await db.q(
    `SELECT "81211","81229","81230" FROM base_sys_emoji_table ORDER BY "81211"`,
  );
  db.close();

  // prefix|ts → id[]，只收有 adv 包（能下载）的行。
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const id = String(r[0] ?? '');
    const base = String(r[1] ?? '');
    const adv = String(r[2] ?? '').trim();
    if (!id || !adv) continue;
    const m = RE.exec(adv);
    if (!m || m[2] !== id) throw new Error(`unexpected adv url for ${id}: ${adv}`);
    const [, prefix, , ts] = m;
    if (base !== `${prefix}/${id}_base_${ts}.zip`) {
      throw new Error(`base/adv mismatch for ${id}: ${base}`);
    }
    const key = `${prefix}|${ts}`;
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  }

  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = sorted.reduce((n, [, ids]) => n + ids.length, 0);

  const lines = sorted.map(([key, ids]) => {
    const [prefix, ts] = key.split('|');
    ids.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
    return `  ['${prefix}', '${ts}', '${ids.join(',')}'],`;
  });

  process.stdout.write(`/**
 * 内置表情资源地址的兜底表 —— 当 \`emoji.db\` 的 \`base_sys_emoji_table\` 读不到内容时使用。
 *
 * 这张表**不是**为了替代数据库，而是残缺环境的最后退路。已知的两种残缺:
 *   - emoji.db 整个不存在（只拿到一份解密库的静态账号）；
 *   - **表在但 0 行** —— QQ 尚未同步过内置表情，实测发生在从没登录过桌面端的环境。
 *     此时 QQ 自己的 EmojiSystermResource 目录多半也不存在，两头皆空。
 *
 * 数据来自一份真实的 emoji.db（生成脚本 \`packages/db/tools/gen_sys_emoji_fallback.ts\`）。
 * 腾讯会更新这张表（新表情、资源改版会换时间戳），所以**数据库永远优先**，这里只在
 * 库读不到时兜底 —— 表情少几个、或某个表情停在旧版本，都好过一个都渲染不出来。
 *
 * URL 完全由 (前缀, id, 时间戳) 决定，且同一 id 的 _base/_adv 共用一组:
 *   <prefix>/<id>_base_<ts>.zip   静态 png
 *   <prefix>/<id>_adv_<ts>.zip    apng + lottie
 * 所以按 (前缀, 时间戳) 分组存 id 列表最省 —— ${total} 个表情压进 ${sorted.length} 组。
 * 只收有 adv 包的表情；Unicode 字符表情（😊 那批）没有资源包，按字符渲染。
 */

/** [前缀, 时间戳, 逗号分隔的 id 列表] */
const GROUPS: ReadonlyArray<readonly [string, string, string]> = [
${lines.join('\n')}
];

/** 一个表情的两个资源包地址。 */
export interface FallbackSysEmojiUrls {
  staticUrl: string;
  apngUrl: string;
}

/** id → 资源包地址。首次调用时展开，之后复用。 */
let cached: Map<string, FallbackSysEmojiUrls> | null = null;

/**
 * 兜底的「id → 资源包地址」表。调用方在数据库读不到内容时用它顶上。
 */
export function fallbackSysEmojiUrls(): Map<string, FallbackSysEmojiUrls> {
  if (cached) return cached;
  const out = new Map<string, FallbackSysEmojiUrls>();
  for (const [prefix, ts, ids] of GROUPS) {
    for (const id of ids.split(',')) {
      out.set(id, {
        staticUrl: \`\${prefix}/\${id}_base_\${ts}.zip\`,
        apngUrl: \`\${prefix}/\${id}_adv_\${ts}.zip\`,
      });
    }
  }
  cached = out;
  return out;
}
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
