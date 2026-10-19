/**
 * 会话列表容器布局的回归测试（纯 CSS 断言）。
 *
 * 回归背景：`.weq-conversation-directory` 根节点同时带 `.list-stack`。后者在
 * `sidebar.css` 里写 `display: grid`，加载顺序比 `conversation-directory.css` 靠后，
 * 同特异性下把 flex 布局覆盖成了 grid。grid 默认 `align-content: stretch` 会把
 * 剩余高度平分给「工具栏 + viewport」两行 —— 筛选后只剩少量会话时，整块列表就被
 * 推到垂直中间，看起来像「居中排列」。
 *
 * 修法是把选择器提成 `.list-stack.weq-conversation-directory`（特异性 0,2,0），
 * 无论加载顺序如何 flex 都生效。这里守两件事：
 *   1. 该规则存在且是 flex 纵向布局；
 *   2. `.list-stack` 的 grid 声明没有被改成会命中会话列表的形式。
 *
 * 跑法：`pnpm --filter @weq/desktop test`。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const DIRECTORY_CSS = 'src/renderer/src/styles/conversation-directory.css';
const SIDEBAR_CSS = 'src/renderer/src/im-template/styles/sidebar.css';

test('会话列表容器用高特异性选择器固定为纵向 flex', () => {
  const css = readFileSync(DIRECTORY_CSS, 'utf8');
  const rule = /\.list-stack\.weq-conversation-directory\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '缺少 .list-stack.weq-conversation-directory 规则');
  const body = rule[1]!;
  assert.match(body, /display:\s*flex/);
  assert.match(body, /flex-direction:\s*column/);
  // 只要还带 grid，align-content: stretch 就会把少量行推到中间。
  assert.doesNotMatch(body, /display:\s*grid/);
});

test('裸 .weq-conversation-directory 规则不再单独声明布局', () => {
  const css = readFileSync(DIRECTORY_CSS, 'utf8');
  // 允许别处引用这个类名（比如 :focus-visible），但不能有裸选择器重新写 display，
  // 否则又会和 .list-stack 打架。
  const bare = /(^|\n)\.weq-conversation-directory\s*\{([^}]*)\}/.exec(css);
  assert.equal(bare, null, '不要保留裸 .weq-conversation-directory 布局规则');
});

test('.list-stack 仍是纯 grid 声明（冲突点已知且被高特异性规则压住）', () => {
  const css = readFileSync(SIDEBAR_CSS, 'utf8');
  const rule = /\.list-stack\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '缺少 .list-stack 规则');
  assert.match(rule[1]!, /display:\s*grid/);
});
