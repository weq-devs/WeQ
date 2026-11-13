/**
 * 文档站构建前的静态检查：链接完整性 + 站内路由可达性。
 *
 * 用法：
 *   node scripts/check-docs.mjs
 *
 * 检查项：
 *   1. 相对链接目标必须存在（指向 docs/ 内或仓库其它目录都算）；
 *   2. 不能有指向 docs/ 外部的相对链接 —— VitePress 会把它当站内路由解析，
 *      构建期报错或产物里出现 404。跨目录引用一律写 GitHub 绝对 URL。
 *
 * 这个脚本不联网，也不读真实数据，纯粹扫文件。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');

/** 递归列出 docs 下的 markdown，跳过构建产物与依赖目录。 */
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

for (const file of walkDocs(DOCS)) {
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
    // 仓库之外，VitePress 也不管，跳过
    if (rel.startsWith('..')) continue;

    if (!rel.startsWith(`docs${sep}`) && rel !== 'docs') {
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
  for (const x of insideBroken) console.error(`  ${x.file}\n    → ${x.link}`);
}
if (escaped.length) {
  failed = true;
  console.error(`\n✖ ${escaped.length} 处相对链接逃出了 docs/（VitePress 会当站内路由解析）：`);
  for (const x of escaped) console.error(`  ${x.file}\n    → ${x.link}   (${x.target})`);
  console.error('  改用 GitHub 绝对 URL，例如 https://github.com/weq-devs/WeQ/blob/dev/<path>');
}

if (failed) process.exit(1);
console.log('✓ 文档链接检查通过');
