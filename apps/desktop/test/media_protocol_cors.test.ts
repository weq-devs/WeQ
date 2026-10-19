/**
 * `weq-media://` 的 kind 路由与 CORS 头（`src/main/media_protocol.ts`）。
 *
 * 两个回归背景：
 *
 * 1. **CORS**：dev 模式下渲染页是 `http://localhost:5173`，`weq-media://` 属于跨源。
 *    图片 / 视频是 no-cors 请求不受影响，但字体走的是 CORS-mode 的 fetch
 *    （`new FontFace(url)`），协议响应缺 `Access-Control-Allow-Origin` 时 Chromium
 *    直接报 "blocked by CORS policy"。
 *
 * 2. **kind 白名单漏项**：曾经为了「未知 kind 提前 404」维护过一份「需要账号」的
 *    kind 清单，结果漏了 dressbubble / dresspendant / dressbg，装扮气泡整片 404。
 *    现在改成「不需要账号」的白名单，新分支默认归到需要账号一侧 —— 这里用源码
 *    断言守住：文件里出现的每个 kind 都必须要么在免账号白名单里，要么能走到
 *    services 之后的分支，不允许再出现第三种「被静默 404」的情况。
 *
 * 不碰真 QQ 数据、不联网。跑法：`pnpm --filter @weq/desktop test`。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol.ts';

const SOURCE = 'src/main/media_protocol.ts';

/** 从源码里抽出所有被处理的 kind（`kind === 'x'` 与 `case 'x'`）。 */
function handledKinds(): Set<string> {
  const source = readFileSync(SOURCE, 'utf8');
  const kinds = new Set<string>();
  for (const match of source.matchAll(/kind === '([a-z]+)'/g)) kinds.add(match[1]!);
  for (const match of source.matchAll(/case '([a-z]+)':/g)) kinds.add(match[1]!);
  return kinds;
}

/** 免账号 kind：文档里约定的四个，只靠 bootstrap 缓存就能解析。 */
const NO_ACCOUNT_KINDS = new Set(['dress', 'qqshow', 'linkpreview', 'redbag']);

/** 在 `services` 断言之前出现的 `if (kind === '…')` 提前返回分支。 */
function earlyKinds(): string[] {
  const source = readFileSync(SOURCE, 'utf8');
  const servicesAt = source.indexOf('services = getAppContext().services');
  assert.ok(servicesAt > 0, '找不到 services 断言位置');
  return [...source.matchAll(/if \(kind === '([a-z]+)'\)/g)]
    .filter((match) => (match.index ?? 0) < servicesAt)
    .map((match) => match[1]!);
}

test('免账号白名单覆盖所有在 services 之前提前返回的 kind', () => {
  const allowed = NO_ACCOUNT_KINDS;
  for (const kind of earlyKinds()) {
    assert.ok(allowed.has(kind), `${kind} 在 services 之前提前返回，但不在免账号白名单里`);
  }
});

test('每个 kind 要么免账号，要么在 services 之后处理（不会被静默 404）', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const servicesAt = source.indexOf('services = getAppContext().services');
  const allowed = NO_ACCOUNT_KINDS;
  const early = earlyKinds();
  for (const kind of handledKinds()) {
    if (allowed.has(kind)) continue;
    // 需要账号的 kind：必须在 services 断言之后出现，否则等于永远 404。
    const index = source.indexOf(`kind === '${kind}'`);
    const caseIndex = source.indexOf(`case '${kind}':`);
    const at = index >= 0 ? index : caseIndex;
    assert.ok(at > servicesAt, `${kind} 在 services 之前就返回了，会被静默 404`);
  }
  // 装扮三件套是最容易漏的，单独点名。
  for (const kind of ['dressbubble', 'dresspendant', 'dressbg', 'dressfont', 'dressfontfx']) {
    assert.ok(handledKinds().has(kind), `缺少 ${kind} 分支`);
    assert.ok(!early.includes(kind), `${kind} 不应在 services 之前提前返回`);
  }
});

/** 未知 kind 在碰 AppContext 之前就 404，不需要账号会话。 */
test('未知 kind 的 404 带 Access-Control-Allow-Origin', async () => {
  const response = await handleMediaRequest(new Request('weq-media://no-such-kind?id=1'));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

/**
 * 需要账号的 kind 在没打开账号（含 AppContext 未初始化）时统一 404 —— 别让
 * `getAppContext` 的 assert 冒出去：协议层抛异常时 Chromium 只看到一个没有 CORS
 * 头的失败，排查时会被误读成跨源问题。
 */
test('需要账号的 kind 无会话时 404 且带跨源头', async () => {
  for (const url of ['weq-media://localfile', 'weq-media://dressfont?id=1']) {
    const response = await handleMediaRequest(new Request(url));
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', url);
    assert.equal(await response.text(), 'no account session', url);
  }
});

/** 只依赖 bootstrap 缓存的 kind 在无账号时也不会抛，且同样带跨源头。 */
test('装扮 / 链接预览等无会话分支同样带跨源头', async () => {
  for (const url of [
    'weq-media://linkpreview?id=none',
    'weq-media://dressbg?v=x',
    'weq-media://redbag?id=none',
  ]) {
    const response = await handleMediaRequest(new Request(url));
    assert.equal(response.headers.get('access-control-allow-origin'), '*', url);
  }
});
