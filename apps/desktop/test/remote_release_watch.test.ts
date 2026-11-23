import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchRemoteRelease } from '../src/renderer/src/lib/remoteWebStartup';
import { setRemoteWorkspaceCheckPending } from '../src/renderer/src/lib/remoteWorkspaceCheck';
import { useViewState } from '../src/renderer/src/state/view';

vi.mock('../src/renderer/src/lib/remoteClient', () => ({ isRemoteClient: () => true }));
vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {} }));

const current = 'a'.repeat(64);
const next = 'b'.repeat(64);
let hidden: boolean;
let versionMeta: HTMLMetaElement;
let close: (() => void) | undefined;
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('location', { hostname: '127.0.0.1', reload });
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  hidden = false;
  reload.mockClear();
  versionMeta = document.createElement('meta');
  versionMeta.name = 'weq-local-web-release';
  versionMeta.content = current;
  document.head.append(versionMeta);
  useViewState.setState({ view: 'main' });
  setRemoteWorkspaceCheckPending(false);
});

afterEach(() => {
  close?.();
  close = undefined;
  versionMeta.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function reply(version: string, waiting = true) {
  return new Response(version, {
    headers: {
      'X-WeQ-Local-Release': '1',
      ...(waiting ? { 'X-WeQ-Local-Release-Wait': '1' } : {}),
    },
  });
}

it.each([
  [false, 180],
  [true, 61],
])('15 分钟稳态只发实际所需的本地请求，支持等待=%s', async (waiting, expected) => {
  const starts: number[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    starts.push(Date.now());
    if (new URL(url, 'http://127.0.0.1').searchParams.has('since'))
      await new Promise<void>((done) => window.setTimeout(done, 15_000));
    return reply(current, waiting);
  });
  close = watchRemoteRelease();
  await vi.advanceTimersByTimeAsync(900_000);
  expect(starts.filter((at) => at < 900_000)).toHaveLength(expected);
  expect(reload).not.toHaveBeenCalled();
});

it('隐藏页面中止版本等待，恢复可见立即检查；滚动中延后应用完整更新', async () => {
  const waiting: AbortSignal[] = [];
  let deliver: ((res: Response) => void) | undefined;
  const fetchVersion = vi.fn(async (url: string, { signal }: { signal: AbortSignal }) => {
    if (!url.includes('since=')) return reply(current);
    waiting.push(signal);
    return new Promise<Response>((resolve, reject) => {
      deliver = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetchVersion);
  close = watchRemoteRelease();
  await vi.advanceTimersByTimeAsync(1);
  expect(waiting).toHaveLength(1);
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(waiting[0]!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchVersion).toHaveBeenCalledTimes(2);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(waiting).toHaveLength(2);
  deliver?.(reply(next));
  for (let i = 0; i < 15; i++) {
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('wheel'));
  }
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(reload).toHaveBeenCalledOnce();
});
