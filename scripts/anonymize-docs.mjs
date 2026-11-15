#!/usr/bin/env node
/**
 * 把文档里的真实账号信息替换成占位符。
 *
 * 文档站要公开（`weq-devs/WeQDocs`），而 `docs/` 里混着真机调试时留下的真实
 * uin / 群号 / uid / 昵称 / 群名。这些属于个人信息，不能随文档一起公开。
 *
 * 用法：
 *
 *   node scripts/anonymize-docs.mjs           # 写盘
 *   node scripts/anonymize-docs.mjs --check   # 只报错，不写盘（CI 用）
 *
 * 也扫 `docs/.vitepress/theme/` 下的 Vue 组件 —— 计算器输入框的 `placeholder`
 * 曾直接写死真实 uin 与 uid，那会渲染进公开页面。
 *
 * ## 映射规则
 *
 * **按号码的第一次出现顺序**编号，同一个号码在所有文件里映射到同一个占位符 ——
 * 这样跨页面的引用关系（「同一个会话」）仍然成立，读者不会看到两个不同的假号
 * 被说成同一个。
 *
 * 时间戳不动：`1790184773` 这类十位数是 Unix 时间戳，不是账号。文档里大量
 * 出现它们（会话时间列），一律保留。
 *
 * ## 不处理什么
 *
 * 微信/QQ 私有服务端的 appId、OIDB 命令号、IPv4 打包值这些是协议常量，不是
 * 个人信息，保持原样 —— 它们本身就是文档要讲的内容。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');

/**
 * 明确的个人信息 → 占位符。键是原文，值按上下文给出可读的假值。
 *
 * 只列**确认是真实账号/昵称**的；协议常量（appId、命令号）不在此表。
 */
const REPLACEMENTS = [
  // 群
  ['673646675', '100000001'],
  ['1090396070', '100000002'],
  ['喵喵喵', '示例群 A'],
  ['开心快乐的跑步', '示例群 B'],
  // 好友
  ['2863253201', '100000003'],
  ['eSTKim', '示例好友'],
  // 真实 uid（好友）
  ['u_LKt3AdAIMP-CUfn6ydzDzw', 'u_EXAMPLEFRIENDUID0000'],
  ['u_LKt3AdAIMP-…', 'u_EXAMPLEFRIENDUID…'],
  ['u_LKt3Ad...', 'u_EXAMPLEFRIEND...'],
  ['u_LKt3…', 'u_EXAMPLEFRIEND…'],
  // 第二个会话的 uid 缩写（send-message.md 里与上一个并列讨论）
  ['u_h3h1...', 'u_EXAMPLESELF...'],
  // 本机测试账号
  ['1707889225', '100000004'],
  // 真实设备的 gpro 库私有头随机串（文档里的「已知测试向量」）
  ['vgdBdzWwwrNNGORk', 'ExampleHeaderStr'],
];

/**
 * 只处理**入库**的 markdown。`.gitignore` 里的文件（如 `develop/redbag.md`）
 * 本来就不会进公开仓库，脱敏它们没有意义；它们会不会泄露是构建配置的问题，
 * 由 `docs/.vitepress/config.mts` 的 `srcExclude` 负责。
 */
function trackedMarkdown() {
  const out = execFileSync('git', ['ls-files', '-z', 'docs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p.endsWith('.md') || p.endsWith('.vue') || p.endsWith('.ts'))
    .map((p) => join(root, p));
}

const files = trackedMarkdown();

/** 逐个文件应用替换。 */
const changed = [];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [from, to] of REPLACEMENTS) after = after.split(from).join(to);
  if (after !== before) {
    changed.push(relative(root, file));
    if (!checkOnly) writeFileSync(file, after);
  }
}

if (checkOnly) {
  if (changed.length > 0) {
    process.stderr.write(
      `✖ ${changed.length} 个文件仍含真实账号信息：\n` +
        changed.map((f) => `  - ${f}`).join('\n') +
        '\n  跑 `pnpm docs:anonymize` 处理。\n',
    );
    process.exit(1);
  }
  process.stdout.write('✓ 文档里没有未脱敏的真实账号信息\n');
  process.exit(0);
}

process.stdout.write(
  changed.length > 0
    ? `✓ 已脱敏 ${changed.length} 个文件\n` + changed.map((f) => `  - ${f}`).join('\n') + '\n'
    : '✓ 无需改动\n',
);
