/**
 * 头像 URL 修复（`lib/avatarResolver.ts` 的 `fixProfileAvatarUrl`）的离线单测。
 *
 * 回归来源：0x9083 回应人面板把服务端 headUrl 交给 `QqAvatar` → `cachedAvatarUrl` →
 * `weq-avatar://fetch?src=…`，而 headUrl 是 `http://qh.qlogo.cn/g?b=qq&ek=…&s=`（**空的
 * s=**）→ 上游 400 → 代理回 502，面板里所有头像都裂。数据库 20004 列的 profile 头像
 * 是同一个形状。
 *
 * 跑法（apps/desktop 没有 test 脚本，不进 `pnpm -r test`）：
 *   cd apps/desktop && node --test test/avatar_url.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixProfileAvatarUrl } from '../src/renderer/src/lib/avatarResolver.ts';

/** 用户报的那条真实 URL（按抓包原样，只有 ek 截断）。 */
const REPORTED =
  'http://qh.qlogo.cn/g?b=qq&ek=AQAcgLJzxjZtz9xDCceozbenq1dl3D1mIVEOkQBDNzq6YucJ6rLnfhaENJUmqCNbIY4iamK6sicv4R9XGUARuE6Gyib3Bbrq8KKrCa2xffJsKN8T91sA0tpGPY1XQicBUA&s=';

test('补全末尾的空 s= 为 s=0（就是那条 502 的 headUrl）', () => {
  assert.equal(fixProfileAvatarUrl(REPORTED), `${REPORTED}0`);
});

test('s= 后面还跟着别的参数时也补齐', () => {
  assert.equal(
    fixProfileAvatarUrl('http://qh.qlogo.cn/g?b=qq&ek=K&s=&fk=1'),
    'http://qh.qlogo.cn/g?b=qq&ek=K&s=0&fk=1',
  );
});

test('已经有 s=<数字> 的不动', () => {
  const ok = 'http://qh.qlogo.cn/g?b=qq&ek=K&s=140';
  assert.equal(fixProfileAvatarUrl(ok), ok);
  const sdk = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
  assert.equal(fixProfileAvatarUrl(sdk), sdk);
});

test('非 qh.qlogo.cn 的 URL 原样返回', () => {
  const other = 'https://p.qlogo.cn/gh/12345/12345/0';
  assert.equal(fixProfileAvatarUrl(other), other);
});

test('空值返回 null（调用方据此回落默认头像）', () => {
  assert.equal(fixProfileAvatarUrl(''), null);
  assert.equal(fixProfileAvatarUrl(undefined), null);
  assert.equal(fixProfileAvatarUrl(null), null);
});
