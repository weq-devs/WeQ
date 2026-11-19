import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { LinkPreviewService, LINK_SCREENSHOT_LIMITS } from '../src/bootstrap/link_preview';
import { UserConfigService } from '../src/bootstrap/user_config';

const network = vi.hoisted(() => ({
  addresses: [{ address: '8.8.8.8', family: 4 }],
  resourceBytes: 4,
}));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => network.addresses) }));
vi.mock('node:http', () => ({
  request: vi.fn((options, callback) => {
    const req = new EventEmitter();
    const resource = options.path === '/asset';
    const redirect = options.path === '/redirect';
    return Object.assign(req, {
      destroy: () => req,
      end: () =>
        callback(
          Object.assign(
            Readable.from([
              resource
                ? Buffer.alloc(network.resourceBytes)
                : Buffer.from('<title>fixture</title>'),
            ]),
            {
              headers: redirect
                ? { location: 'http://127.0.0.1/private' }
                : { 'content-type': resource ? 'image/png' : 'text/html' },
              statusCode: redirect ? 302 : 200,
            },
          ),
        ),
    });
  }),
}));
import { request } from 'node:http';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  network.addresses = [{ address: '8.8.8.8', family: 4 }];
  network.resourceBytes = 4;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function service() {
  const root = mkdtempSync(join(tmpdir(), 'weq-link-shot-'));
  roots.push(root);
  const settings = new UserConfigService({ appDataRoot: () => root } as Platform);
  settings.setSettings({ linkPreview: { autoFetch: true, screenshot: true } });
  return new LinkPreviewService(settings);
}

it('截图接收已取得的 HTML，而不是重新下载原始 URL', async () => {
  const preview = service();
  let actual: unknown;
  const shot = vi.fn(async (input: unknown) => {
    actual = input;
    return null;
  });
  preview.setScreenshotHook(shot);
  expect(await preview.get('http://synthetic.invalid/page')).toMatchObject({ title: 'fixture' });
  expect(shot).toHaveBeenCalledOnce();
  expect(actual).toMatchObject({
    url: 'http://synthetic.invalid/page',
    html: '<title>fixture</title>',
  });
});

it('截图资源在传输前拒绝内网和重绑定地址', async () => {
  const preview = service();
  const results: unknown[] = [];
  preview.setScreenshotHook(async (input) => {
    network.addresses = [{ address: '127.0.0.1', family: 4 }];
    results.push(await input.fetchResource('http://synthetic.invalid/private'));
    results.push(await input.fetchResource('http://[::ffff:7f00:1]/private'));
    return null;
  });
  await preview.get('http://synthetic.invalid/page');
  expect(results).toEqual([null, null]);
  expect(request).toHaveBeenCalledTimes(1);
});

it('截图子请求有次数预算，耗尽后取消且不再连接', async () => {
  const preview = service();
  let aborted = false;
  preview.setScreenshotHook(async (input) => {
    for (let index = 0; index < 70; index++)
      await input.fetchResource(`http://synthetic.invalid/resource-${index}`);
    aborted = input.signal.aborted;
    return null;
  });
  expect(await preview.get('http://synthetic.invalid/page')).toMatchObject({ title: 'fixture' });
  expect(aborted).toBe(true);
  expect(request).toHaveBeenCalledTimes(LINK_SCREENSHOT_LIMITS.maxRequests + 1);
});

it('截图子资源逐跳校验，重定向到内网不连接', async () => {
  const preview = service();
  const results: unknown[] = [];
  preview.setScreenshotHook(async (input) => {
    results.push(await input.fetchResource('http://synthetic.invalid/redirect'));
    return null;
  });
  await preview.get('http://synthetic.invalid/page');
  expect(results).toEqual([null]);
  expect(request).toHaveBeenCalledTimes(2);
});

it('单资源和总字节预算都取消截图，同时保留文字卡片', async () => {
  for (const oversized of [true, false]) {
    const preview = service();
    network.resourceBytes = LINK_SCREENSHOT_LIMITS.maxResourceBytes + Number(oversized);
    let aborted = false;
    preview.setScreenshotHook(async (input) => {
      for (let index = 0; index < 5; index++)
        await input.fetchResource('http://synthetic.invalid/asset');
      aborted = input.signal.aborted;
      return null;
    });
    expect(await preview.get('http://synthetic.invalid/page')).toMatchObject({
      title: 'fixture',
      image: '',
    });
    expect(aborted).toBe(true);
  }
});
