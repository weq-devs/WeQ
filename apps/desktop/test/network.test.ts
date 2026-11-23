// @vitest-environment node
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { electronNetworkFetch, installDesktopNetwork } from '../src/main/network';

const { net, onErrorOccurred } = vi.hoisted(() => ({
  net: { request: vi.fn(), fetch: vi.fn() },
  onErrorOccurred:
    vi.fn<
      (
        filter: { urls: string[] } | null,
        listener?: (details: { url: string; error: string }) => void,
      ) => void
    >(),
}));
vi.mock('electron', () => ({
  net,
  app: { on: vi.fn(), off: vi.fn() },
  session: { defaultSession: { webRequest: { onErrorOccurred } }, fromPartition: () => ({}) },
}));

function clientRequest() {
  return Object.assign(new EventEmitter(), { end: vi.fn(), abort: vi.fn() });
}
function incoming(headers: Record<string, string | string[] | undefined>, statusCode = 200) {
  return Object.assign(Readable.from([Buffer.from('%PDF-synthetic')]), { headers, statusCode });
}

beforeEach(() => vi.resetAllMocks());

it('开发日志只将已配置的 GitHub 发布镜像连接失败降到 DEBUG', () => {
  vi.stubEnv('WEQ_DEV_CONSOLE', '1');
  const report = vi.fn();
  const stop = installDesktopNetwork(report);
  try {
    const listener = onErrorOccurred.mock.calls[0]?.[1];
    expect(listener).toBeTypeOf('function');
    const error = 'net::ERR_CONNECTION_CLOSED';
    listener?.({
      url: 'https://github.chenc.dev/https://github.com/x/y/releases/download/v1/file',
      error,
    });
    listener?.({ url: 'https://github.chenc.dev/health', error });
    listener?.({ url: 'https://github.com/x/y/releases/download/v1/file', error });
    expect(report.mock.calls).toEqual([
      ['debug', 'github.chenc.dev', error],
      ['error', 'github.chenc.dev', error],
      ['error', 'github.com', error],
    ]);
  } finally {
    stop();
    vi.unstubAllEnvs();
  }
});

describe('Electron 下载传输', () => {
  it('中文文件名响应头不抛出事件异常，正文按需读取且内容不变', async () => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const work = electronNetworkFetch('https://synthetic.invalid/file');
    const disposition = 'attachment; filename="发票信息-2026.pdf"';
    const response = incoming({
      'content-disposition': disposition,
      'content-type': 'application/pdf',
    });
    const resume = vi.spyOn(response, 'resume');

    expect(() => request.emit('response', response)).not.toThrow();
    const result = await work;
    expect(result.url).toBe('https://synthetic.invalid/file');
    expect(result.redirected).toBe(false);
    expect(result.headers.get('content-disposition')).toBe(
      'attachment; filename="\xe5\x8f\x91\xe7\xa5\xa8\xe4\xbf\xa1\xe6\x81\xaf-2026.pdf"',
    );
    expect(result.headers.get('content-type')).toBe('application/pdf');
    expect(resume).not.toHaveBeenCalled();
    expect(await result.text()).toBe('%PDF-synthetic');
    expect(resume).toHaveBeenCalled();
    expect(request.abort).not.toHaveBeenCalled();
  });

  it.each([
    'attachment; filename="invoice.pdf"',
    'attachment; filename="café.pdf"',
    'attachment; filename="\xe5\x8f\x91.pdf"',
    "attachment; filename*=UTF-8''%E5%8F%91%E7%A5%A8.pdf",
  ])('保留已有 ByteString／已编码文件名：%s', async (disposition) => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const work = electronNetworkFetch('https://synthetic.invalid/file');
    request.emit(
      'response',
      incoming({
        'content-disposition': disposition,
        'set-cookie': ['one=1', 'two=2'],
        'x-absent': undefined,
      }),
    );
    const result = await work;
    expect(result.headers.get('content-disposition')).toBe(disposition);
    expect(result.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
    expect(result.headers.has('x-absent')).toBe(false);
    await result.body?.cancel();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it('重定向中的中文响应头同样兼容，跨域后移除凭据和完整来源地址并保留下载范围', async () => {
    const first = clientRequest();
    const second = clientRequest();
    net.request.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const work = electronNetworkFetch('https://synthetic.invalid/file', {
      referrerPolicy: 'no-referrer-when-downgrade',
      headers: {
        authorization: 'Bearer fixture',
        cookie: 'fixture=1',
        range: 'bytes=4-',
        referer: 'https://source.invalid/space/profile',
      },
    });
    expect(() =>
      first.emit('redirect', 302, 'GET', 'https://cdn.invalid/file', {
        'content-disposition': ['attachment; filename="发票.pdf"'],
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(net.request).toHaveBeenCalledTimes(2));
    expect(first.abort).toHaveBeenCalledOnce();
    expect(net.request.mock.calls[1][0]).toMatchObject({
      url: 'https://cdn.invalid/file',
      headers: { range: 'bytes=4-' },
    });
    expect(net.request.mock.calls[1][0].headers).not.toHaveProperty('authorization');
    expect(net.request.mock.calls[1][0].headers).not.toHaveProperty('cookie');
    expect(net.request.mock.calls[1][0].headers).not.toHaveProperty('referer');
    second.emit('response', incoming({ 'content-range': 'bytes 4-17/18' }, 206));
    const result = await work;
    expect(result.url).toBe('https://cdn.invalid/file');
    expect(result.redirected).toBe(true);
    expect(result.status).toBe(206);
    expect(await result.text()).toBe('%PDF-synthetic');
  });

  it('手动重定向保留多值头并规范化 Unicode 地址', async () => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const work = electronNetworkFetch('https://synthetic.invalid/file', { redirect: 'manual' });
    expect(() =>
      request.emit('redirect', 302, 'GET', '/发票.pdf', {
        'x-label': ['下载📄', 'ready'],
      }),
    ).not.toThrow();
    const result = await work;
    expect(result.headers.get('location')).toBe('https://synthetic.invalid/%E5%8F%91%E7%A5%A8.pdf');
    expect(Buffer.from(result.headers.get('x-label')!, 'latin1').toString('utf8')).toBe(
      '下载📄, ready',
    );
    expect(result.body).toBeNull();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it.each(['response', 'redirect', 'status'] as const)(
    '%s 构造失败时拒绝请求并关闭连接，不外抛事件异常',
    async (event) => {
      const request = clientRequest();
      net.request.mockReturnValue(request);
      const controller = new AbortController();
      const work = electronNetworkFetch('https://synthetic.invalid/file', {
        signal: controller.signal,
      });
      const outcome = expect(work).rejects.toBeInstanceOf(
        event === 'status' ? RangeError : TypeError,
      );
      const emit = () =>
        event === 'redirect'
          ? request.emit('redirect', 302, 'GET', 'https://cdn.invalid/file', {
              'x-invalid': ['bad\r\nvalue'],
            })
          : request.emit(
              'response',
              incoming(
                event === 'status' ? {} : { 'x-invalid': 'bad\r\nvalue' },
                event === 'status' ? 101 : 200,
              ),
            );
      expect(emit).not.toThrow();
      await outcome;
      expect(request.abort).toHaveBeenCalledOnce();
      controller.abort();
      expect(request.abort).toHaveBeenCalledOnce();
    },
  );

  it('收头前取消后忽略迟到响应', async () => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const controller = new AbortController();
    const work = electronNetworkFetch('https://synthetic.invalid/file', {
      signal: controller.signal,
    });
    const outcome = expect(work).rejects.toThrow('fixture cancelled');
    controller.abort(new Error('fixture cancelled'));
    await outcome;
    expect(request.abort).toHaveBeenCalledOnce();
    expect(() => request.emit('response', incoming({ 'x-invalid': 'bad\nvalue' }))).not.toThrow();
  });

  it('收头后的连接中断交给正文读取者', async () => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const work = electronNetworkFetch('https://synthetic.invalid/file');
    const response = incoming({});
    request.emit('response', response);
    const result = await work;
    response.emit('aborted');
    await expect(result.text()).rejects.toThrow('下载连接中断');
  });

  it.each([
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 205],
    ['GET', 304],
  ] as const)('%s %i 不创建正文流', async (method, status) => {
    const request = clientRequest();
    net.request.mockReturnValue(request);
    const work = electronNetworkFetch('https://synthetic.invalid/file', { method });
    request.emit('response', incoming({}, status));
    expect((await work).body).toBeNull();
  });
});
