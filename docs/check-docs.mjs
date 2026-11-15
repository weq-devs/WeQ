/**
 * 文档站构建前的静态检查：链接完整性 + 站内路由可达性。
 *
 * 用法：
 *   node check-docs.mjs
 *
 * 检查项：
 *   1. 相对链接目标必须存在（指向内容根内或仓库其它目录都算）；
 *   2. 不能有指向内容根之外的相对链接 —— VitePress 会把它当站内路由解析，
 *      构建期报错或产物里出现 404。跨目录引用一律写 GitHub 绝对 URL。
 *
 * 这个脚本不联网，也不读真实数据，纯粹扫文件。
 *
 * ## 为什么脚本住在文档目录里
 *
 * 文档站是独立仓库（`weq-devs/WeQDocs`），仓库根就是内容根；在主仓里它挂在 `docs/`。
 * 脚本跟着内容走，两种 checkout 下都不需要知道「仓库根在哪」—— 以前它写死了
 * `../scripts/check-docs.mjs` + `join(ROOT, 'docs')`，拆仓后第一条路径就不存在了。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** 内容根：脚本所在目录。主仓里是 `docs/`，独立仓库里是仓库根。 */
const ROOT = import.meta.dirname;

/** 递归列出内容根下的 markdown，跳过构建产物、依赖与静态资源目录。 */
function walkDocs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.vitepress' || name === 'node_modules' || name === 'public') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkDocs(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// [label](target) 与 ![alt](target)；target 允许带 title
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)/g;

const insideBroken = [];
const escaped = [];

for (const file of walkDocs(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const relFile = relative(ROOT, file);
  for (const m of src.matchAll(LINK_RE)) {
    const raw = m[1];
    // http(s)/mailto/自定义 scheme 一律跳过
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    // 纯锚点
    if (raw.startsWith('#')) continue;
    // 以 / 开头的是 VitePress 站内路由，由构建期校验
    if (raw.startsWith('/')) continue;

    const target = raw.split('#')[0];
    if (!target) continue;

    const abs = resolve(dirname(file), target);
    const rel = relative(ROOT, abs);
    if (rel.startsWith('..')) {
      // 指向内容根之外：主仓布局下它可能指向源码或 CHANGELOG，但文档站拆出去后
      // 这些相对路径必然 404。跨目录引用一律写 GitHub 绝对 URL。
      escaped.push({ file: relFile, link: raw, target: rel });
    } else if (!existsSync(abs)) {
      insideBroken.push({ file: relFile, link: raw, target: rel });
    }
  }
}

let failed = false;
if (insideBroken.length) {
  failed = true;
  console.error(`\n✖ ${insideBroken.length} 处相对链接指向不存在的文件：`);
  for (const x of insideBroken) console.error(`  ${x.file}\n    → ${x.link}   (${x.target})`);
}
if (escaped.length) {
  failed = true;
  console.error(`\n✖ ${escaped.length} 处相对链接逃出了内容根（VitePress 会当站内路由解析）：`);
  for (const x of escaped) console.error(`  ${x.file}\n    → ${x.link}   (${x.target})`);
  console.error('  改用 GitHub 绝对 URL，例如 https://github.com/weq-devs/WeQ/blob/dev/<path>');
}

if (failed) process.exit(1);
console.log('✓ 文档链接检查通过');
