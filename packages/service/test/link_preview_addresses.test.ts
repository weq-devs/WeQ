import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { LinkPreviewService } from '../src/bootstrap/link_preview';
import { UserConfigService } from '../src/bootstrap/user_config';

const network = vi.hoisted(() => ({
  addresses: [] as { address: string; family: number }[],
  error: undefined as Error | undefined,
  debug: vi.fn(),
}));
vi.mock('../src/common/logger', async (original) => {
  const actual = await original<typeof import('../src/common/logger')>();
  const wrap = (
    logger: import('../src/common/logger').Logger,
  ): import('../src/common/logger').Logger => ({
    debug: network.debug,
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
    child: (context) => wrap(logger.child(context)),
  });
  return { ...actual, getLogger: () => wrap(actual.getLogger()) };
});
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => network.addresses) }));
vi.mock('node:http', () => ({
  request: vi.fn((_options, callback) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      destroy: () => req,
      end: () => {
        if (network.error) {
          queueMicrotask(() => req.emit('error', network.error));
          return;
        }
        const res = Object.assign(
          Readable.from([Buffer.from('<html><title>fixture</title></html>')]),
          {
            headers: { 'content-type': 'text/html' },
            statusCode: 200,
          },
        );
        callback(res);
      },
    });
  }),
}));
import { request } from 'node:http';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  network.error = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function service() {
  const root = mkdtempSync(join(tmpdir(), 'weq-link-address-'));
  roots.push(root);
  const config = new UserConfigService({ appDataRoot: () => root } as Platform);
  config.setSettings({ linkPreview: { autoFetch: true } });
  return new LinkPreviewService(config);
}

it.each([
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '0:0:0:0:0:ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:192.168.1.1',
  '::127.0.0.1',
  '::7f00:1',
  '::1',
  'fc00::1',
  'fe80::1',
  'ff02::1',
])('URL 和 DNS 均拒绝非公网 IPv6 %s', async (address) => {
  const preview = service();
  expect(await preview.get(`http://[${address}]/private`)).toBeNull();
  network.addresses = [{ address, family: 6 }];
  expect(await preview.get('http://synthetic.invalid/private')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it.each(['8.8.8.8', '::ffff:8.8.8.8', '2001:4860:4860::8888'])(
  '公开地址仍可请求，并把同一地址交给连接 %s',
  async (address) => {
    network.addresses = [{ address, family: address.includes(':') ? 6 : 4 }];
    expect(await service().get('http://synthetic.invalid/public')).toMatchObject({
      title: 'fixture',
    });
    const options = vi.mocked(request).mock.calls[0]?.[0] as {
      lookup: (
        host: string,
        options: unknown,
        cb: (error: null, addresses: unknown) => void,
      ) => void;
    };
    const callback = vi.fn();
    options.lookup('synthetic.invalid', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, network.addresses);
  },
);
it('失败诊断不保存 URL 路径、query、fragment 或错误链中的票据', async () => {
  network.addresses = [{ address: '8.8.8.8', family: 4 }];
  network.error = new Error('SYNTHETIC_ERROR_TICKET', {
    cause: new Error('SYNTHETIC_CAUSE_TICKET'),
  });
  await service().get(
    'http://synthetic.invalid/SYNTHETIC_PATH_TICKET?ticket=SYNTHETIC_QUERY_TICKET#SYNTHETIC_FRAGMENT_TICKET',
  );
  const failures = network.debug.mock.calls.filter(
    ([message]) => message === 'link preview failed',
  );
  expect(failures).toHaveLength(1);
  const log = JSON.stringify(failures);
  expect(log).not.toContain('SYNTHETIC_');
  expect(log).toContain('http://synthetic.invalid');
});
