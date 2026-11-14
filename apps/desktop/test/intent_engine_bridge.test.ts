// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), appDataRoot: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: mocks.fork }));
vi.mock('@weq/service', () => ({
  getLogger: () => ({ child: () => ({ warn: vi.fn() }) }),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ platform: { appDataRoot: mocks.appDataRoot } }),
}));
vi.mock('../src/main/intent_sense/model_files', () => ({
  downloadLayaBundle: vi.fn(),
  isLayaBundleReady: () => true,
  layaBundleStore: (dir: string) => ({ resolveModelDir: () => dir }),
}));
import { getIntentSenseLocalEngine } from '../src/main/intent_sense/bridge';

class Worker extends EventEmitter {
  stderr = new PassThrough();
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  send = vi.fn((message: { type: string }) => {
    if (message.type === 'load') queueMicrotask(() => this.emit('message', { type: 'ready' }));
    if (message.type === 'close') {
      this.exitCode = 0;
      this.emit('exit', 0);
    }
  });
  kill = vi.fn();
}

let root: string;
let resources: string;
let worker: Worker;
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-intent-bridge-'));
  resources = join(root, 'weQ.app', 'Contents', 'Resources');
  mkdirSync(join(resources, 'out', 'main'), { recursive: true });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
  mocks.appDataRoot.mockReturnValue(join(root, 'Application Support', 'WeQ'));
  worker = new Worker();
  mocks.fork.mockReturnValue(worker);
});

afterEach(async () => {
  await getIntentSenseLocalEngine().stop();
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('安装版意图引擎从 Resources 中的实体 worker 启动，不使用 asar 内部路径', async () => {
  const physical = join(resources, 'out', 'main', 'intentSenseWorker.mjs');
  writeFileSync(physical, 'fixture');
  const virtualDir = join(resources, 'app.asar', 'out', 'main');
  mkdirSync(virtualDir, { recursive: true });
  writeFileSync(join(virtualDir, 'intentSenseWorker.mjs'), 'virtual fixture');

  await getIntentSenseLocalEngine().start();
  expect(mocks.fork).toHaveBeenCalledOnce();
  const [path, args, options] = mocks.fork.mock.calls[0]!;
  expect(path).toBe(physical);
  expect(args).toEqual([]);
  expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
  expect(worker.send).toHaveBeenCalledWith({
    type: 'load',
    modelDir: join(root, 'Application Support', 'WeQ', 'models', 'laya-multilingual'),
  });
});

it('缺少实体意图 worker 时直接给出安装包诊断，不启动无效路径', async () => {
  await expect(getIntentSenseLocalEngine().start()).rejects.toThrow(
    '缺少可执行的 intentSenseWorker.mjs',
  );
  expect(mocks.fork).not.toHaveBeenCalled();
});
