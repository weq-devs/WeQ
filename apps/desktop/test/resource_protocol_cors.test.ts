// @vitest-environment node
/**
 * `weq-asset://` 的 CORS 回归测试。
 *
 * dev 模式下渲染页是 `http://localhost:5173`，浮屏挂件的 `fullscreen.json`
 * 通过 CORS-mode 的 fetch 读取。协议既要在特权声明里开启 `corsEnabled`，
 * 也要在响应里带回 `Access-Control-Allow-Origin`，否则 Chromium 会未等请求
 * 落到 handler 就报 "blocked by CORS policy"。
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RESOURCE_PRIVILEGED_SCHEME,
  handleResourceRequest,
} from '../src/main/resource_protocol.ts';

test('资源协议被注册为支持 CORS 的特权协议', () => {
  assert.equal(RESOURCE_PRIVILEGED_SCHEME.privileges.corsEnabled, true);
});

test('浮屏挂件 JSON 经协议读取时带跨源头', async () => {
  const response = await handleResourceRequest(
    new Request('weq-asset://dress/screen/11/fullscreen.json'),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.ok((await response.json()) as object);
});

test('资源 404 同样带跨源头', async () => {
  const response = await handleResourceRequest(new Request('weq-asset://missing/file.json'));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
