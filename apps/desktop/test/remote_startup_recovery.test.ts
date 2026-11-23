// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startupShell } from '../src/main/web/startup_assets';
import {
  REMOTE_STARTUP_RESOURCE_STALL_MS,
  REMOTE_STARTUP_RESOURCE_RETRY_MS,
} from '../src/main/web/startup_recovery';

let root: string;
let script: string;
beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(join(tmpdir(), 'weq-startup-recovery-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/main-12345678.js'), 'export const fixture=1;');
  const html = await startupShell(
    root,
    '<head><script type="module" src="/assets/main-12345678.js"></script></head>',
    false,
  );
  const scripts: string[] = [];
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node && node.tagName === 'script' && node.attrs.length === 0)
      scripts.push(node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''));
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  script = scripts.join('\n');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('并行首屏请求分别返回正确的协商清单，更新入口后重新准备文档', async () => {
  const entry = '/assets/new-12345678.js';
  await writeFile(
    join(root, 'weq-startup.json'),
    JSON.stringify({
      version: 1,
      entry,
      resources: [{ path: entry, raw: 4096, gzip: 777, preload: false }],
    }),
  );
  const document = `<head><script type="module" src="${entry}"></script></head>`;
  const [encoded, raw] = await Promise.all([
    startupShell(root, document, true),
    startupShell(root, document, false),
  ]);
  expect(encoded).toContain('&quot;size&quot;:777');
  expect(raw).toContain('&quot;size&quot;:4096');
  expect(await startupShell(root, document, true)).toBe(encoded);
  const changed = await startupShell(
    root,
    document.replace(entry, '/assets/main-12345678.js'),
    true,
  );
  expect(changed).toContain('&quot;path&quot;:&quot;/assets/main-12345678.js&quot;');
  expect(changed).not.toContain('&quot;size&quot;:777');
});

type Startup = { state: string; message?: string };
type ResourceEvent = { type?: string; target?: object };
function page(
  href = 'https://fixture.invalid/?keep=1#chat',
  paths = ['/assets/main-12345678.js'],
  workspace: string[] = [],
) {
  const events = new Map<string, Set<(event: ResourceEvent) => void>>();
  const fetch = vi.fn(async (_path: string, _options: { cache: string; signal: AbortSignal }) => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  const doc = {
    addEventListener(name: string, handler: (event: ResourceEvent) => void) {
      const handlers = events.get(name) ?? new Set();
      handlers.add(handler);
      events.set(name, handlers);
    },
    removeEventListener(name: string, handler: (event: ResourceEvent) => void) {
      events.get(name)?.delete(handler);
    },
    querySelector: (selector: string) => ({
      content: JSON.stringify({
        version: 1,
        resources: (selector.includes('weq-offline-bundle') ? workspace : paths).map((path) => ({
          path,
        })),
      }),
    }),
  };
  const location = { href, origin: new URL(href).origin, reload: vi.fn() };
  const history = {
    state: { fixture: true },
    replaceState: vi.fn((_state: unknown, _unused: string, next: string | URL) => {
      location.href = new URL(next, location.href).href;
    }),
  };
  const window = Object.assign(new EventTarget(), {
    weqRemoteStartup: undefined as Startup | undefined,
    weqRemoteStartupRetrying: false,
    weqRemoteResourceLoads: undefined as Record<string, boolean> | undefined,
    location,
    history,
  });
  runInNewContext(script, {
    window,
    document: doc,
    location,
    history,
    URL,
    Event,
    setTimeout,
    clearTimeout,
    fetch,
    AbortController,
  });
  return {
    window,
    location,
    history,
    fetch,
    resource(type: 'load' | 'error', path = '/assets/main-12345678.js', tagName = 'SCRIPT') {
      for (const handler of events.get(type) ?? [])
        handler({ type, target: { tagName, src: path, href: path } });
    },
    startup(state: Startup) {
      window.weqRemoteStartup = state;
      window.dispatchEvent(new Event('weq-remote-startup'));
    },
    startupImportError() {
      window.dispatchEvent(new Event('weq-remote-startup-import-failed'));
    },
  };
}

it.each(['SCRIPT', 'LINK'])('首屏 %s 失败自动重载一次，保留原查询和锚点', async (tag) => {
  const first = page();
  first.resource('error', '/assets/main-12345678.js', tag);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.location.reload).toHaveBeenCalledOnce();
  expect(first.fetch).toHaveBeenCalledWith(
    '/assets/main-12345678.js',
    expect.objectContaining({ cache: 'reload' }),
  );
  expect(first.window.weqRemoteStartupRetrying).toBe(true);
  const url = new URL(first.location.href);
  expect(url.searchParams.get('keep')).toBe('1');
  expect(url.hash).toBe('#chat');
  const second = page(first.location.href);
  second.resource('error');
  expect(second.location.reload).not.toHaveBeenCalled();
  expect(second.window.weqRemoteStartup).toMatchObject({ state: 'error' });
});

it('只在开始进入工作区后把离线清单里的分包纳入重试', async () => {
  const entry = '/assets/main-12345678.js';
  const workspace = '/assets/workspace-12345678.js';
  const before = page(undefined, [entry], [entry, workspace]);
  before.resource('error', workspace);
  expect(before.fetch).not.toHaveBeenCalled();
  before.startup({ state: 'ready' });

  const entering = page(undefined, [entry], [entry, workspace]);
  entering.window.weqRemoteResourceLoads = { [entry]: true, [workspace]: false };
  entering.window.dispatchEvent(new Event('weq-remote-workspace-loading'));
  entering.resource('error', workspace);
  await vi.advanceTimersByTimeAsync(0);
  expect(entering.fetch).toHaveBeenCalledOnce();
  expect(entering.fetch).toHaveBeenCalledWith(
    workspace,
    expect.objectContaining({ cache: 'reload' }),
  );
});

it('同一轮多个资源同时失败、模块预载异常只触发一次重载', async () => {
  const first = page();
  first.startupImportError();
  await vi.advanceTimersByTimeAsync(0);
  first.resource('error');
  first.startupImportError();
  expect(first.location.reload).toHaveBeenCalledOnce();
  expect(first.window.weqRemoteStartup?.state).toBe('loading');
});

it('首屏资源卡住时不等原生总超时，连续无进展后重试一次并结束失败', async () => {
  const first = page();
  await vi.advanceTimersByTimeAsync(REMOTE_STARTUP_RESOURCE_STALL_MS);
  expect(first.location.reload).toHaveBeenCalledOnce();
  const second = page(first.location.href);
  vi.advanceTimersByTime(REMOTE_STARTUP_RESOURCE_STALL_MS);
  expect(second.location.reload).not.toHaveBeenCalled();
  expect(second.window.weqRemoteStartup).toMatchObject({ state: 'error' });
  expect(vi.getTimerCount()).toBe(0);
});

it('真实资源就绪才延长等待，重复阶段通知不能无限重置卡住计时', async () => {
  const first = page();
  vi.advanceTimersByTime(10_000);
  first.resource('load');
  vi.advanceTimersByTime(10_000);
  expect(first.location.reload).not.toHaveBeenCalled();
  first.resource('load');
  first.startup({ state: 'loading', message: '正在加载界面模块' });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(first.location.reload).toHaveBeenCalledOnce();
});

it('页面离开时停止计时，旧页面不能触发迟到重试', () => {
  const first = page();
  first.window.dispatchEvent(new Event('pagehide'));
  vi.advanceTimersByTime(REMOTE_STARTUP_RESOURCE_STALL_MS * 2);
  expect(first.location.reload).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('恢复与账号检查不算资源卡住，重新进入模块阶段才计时', async () => {
  const first = page();
  first.startup({ state: 'loading', message: '正在检查恢复状态' });
  vi.advanceTimersByTime(30_000);
  expect(first.location.reload).not.toHaveBeenCalled();
  first.startup({ state: 'loading', message: '正在加载界面模块' });
  await vi.advanceTimersByTimeAsync(REMOTE_STARTUP_RESOURCE_STALL_MS);
  expect(first.location.reload).toHaveBeenCalledOnce();
});

it.each(['ready', 'action-required', 'error'])('%s 后停止监听和计时，不重跑已打开页面', (state) => {
  const first = page();
  first.startup({ state });
  first.resource('error');
  first.startupImportError();
  vi.advanceTimersByTime(60_000);
  expect(first.location.reload).not.toHaveBeenCalled();
  expect(first.window.weqRemoteStartup?.state).toBe(state);
  expect(vi.getTimerCount()).toBe(0);
});

it('重试成功去除重试标记，不污染下次连接与历史状态', async () => {
  const first = page();
  first.resource('error');
  await vi.advanceTimersByTimeAsync(0);
  const second = page(first.location.href);
  second.startup({ state: 'ready' });
  expect(second.location.href).toBe('https://fixture.invalid/?keep=1#chat');
  expect(second.history.replaceState).toHaveBeenCalledWith(
    second.history.state,
    '',
    expect.any(String),
  );
});

it('资源重取仍失败立即报错，不进入无效重载', async () => {
  const first = page();
  first.fetch.mockResolvedValue({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });
  first.resource('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(first.fetch).toHaveBeenCalledOnce();
  expect(first.location.reload).not.toHaveBeenCalled();
  expect(first.window.weqRemoteStartup?.state).toBe('error');
  expect(vi.getTimerCount()).toBe(0);
});

it('只重取失败资源，不清除或重新下载已经就绪的代码', async () => {
  const first = page(undefined, ['/assets/main-12345678.js', '/assets/shared-12345678.js']);
  first.resource('load', '/assets/shared-12345678.js');
  first.resource('error');
  await vi.advanceTimersByTimeAsync(0);
  expect(first.fetch).toHaveBeenCalledOnce();
  expect(first.fetch.mock.calls[0]?.[0]).toBe('/assets/main-12345678.js');
  expect(first.location.reload).toHaveBeenCalledOnce();
});

it('重取资源同样卡住时有独立期限，取消后结束本次重试', async () => {
  const first = page();
  first.fetch.mockImplementation(
    (_path?: string, options?: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options!.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  first.resource('error');
  await vi.advanceTimersByTimeAsync(REMOTE_STARTUP_RESOURCE_RETRY_MS);
  expect(first.location.reload).not.toHaveBeenCalled();
  expect(first.window.weqRemoteStartup?.state).toBe('error');
  expect(vi.getTimerCount()).toBe(0);
});

it('重取期间离开页面会取消请求，不触发迟到重载或报错', async () => {
  const first = page();
  first.fetch.mockImplementation(
    (_path, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  first.resource('error');
  first.window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(REMOTE_STARTUP_RESOURCE_RETRY_MS * 2);
  expect(first.location.reload).not.toHaveBeenCalled();
  expect(first.window.weqRemoteStartup?.state).toBe('loading');
  expect(vi.getTimerCount()).toBe(0);
});

it('图片、外站脚本和非首屏资源失败不触发首屏重载', () => {
  const first = page();
  first.resource('error', '/assets/main-12345678.js', 'IMG');
  first.resource('error', 'https://external.invalid/assets/main-12345678.js');
  first.resource('error', '/assets/optional-12345678.js');
  first.window.dispatchEvent(new Event('vite:preloadError'));
  expect(first.fetch).not.toHaveBeenCalled();
  expect(first.location.reload).not.toHaveBeenCalled();
});
