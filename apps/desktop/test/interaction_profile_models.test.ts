import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ selected: 'QWeQ-NineBird-v1', loaded: [] as string[] }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ bootstrap: { userConfig: { getLocalModelId: () => fixture.selected } } }),
}));
vi.mock('@weq/service', () => ({ getLogger: () => ({ child: () => ({ warn: vi.fn() }) }) }));
vi.mock('node:fs', () => ({ existsSync: () => true, default: { existsSync: () => true } }));
vi.mock('../src/main/intent_sense/model_files', () => ({
  isLayaBundleReady: () => true,
  downloadLayaBundle: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const mock = {
    fork: () => {
      const worker = new EventEmitter();
      return Object.assign(worker, {
        stderr: new EventEmitter(),
        kill: vi.fn(),
        send: (message: { type: string; modelDir?: string; id?: number }) => {
          if (message.type === 'load') fixture.loaded.push(message.modelDir!);
          void Promise.resolve().then(() => {
            if (message.type === 'load') worker.emit('message', { type: 'ready' });
            if (message.type === 'analyze')
              worker.emit('message', {
                type: 'result',
                id: message.id,
                intent: 'chat',
                emotion: 'neutral',
                intensity: 40,
                sentiment: 0,
                confidence: 1,
              });
          });
        },
      });
    },
  };
  return { ...mock, default: mock };
});
import { getIntentSenseLocalEngine } from '../src/main/intent_sense/bridge';
import { downloadLayaBundle } from '../src/main/intent_sense/model_files';

afterEach(async () => {
  await getIntentSenseLocalEngine().stop();
  fixture.loaded.length = 0;
  vi.useRealTimers();
});

it('意图与画像分别路由到所选资源，相同资源复用 worker，切换意图不改变画像端口', async () => {
  fixture.selected = 'QWeQ-NineBird-v1';
  const engine = getIntentSenseLocalEngine();
  const profile = engine.forModel!('laya-multilingual');
  await engine.analyze('合成意图输入');
  await profile.analyze('合成画像输入');
  expect(fixture.loaded).toHaveLength(2);
  expect(fixture.loaded[0]).toContain('QWeQ-NineBird-v1');
  expect(fixture.loaded[1]).toContain('laya-multilingual');
  expect(engine.forModel!('laya-multilingual')).toBe(profile);
  fixture.selected = 'laya-multilingual';
  await engine.analyze('切换后的合成输入');
  await profile.analyze('画像输入保持资源');
  expect(fixture.loaded).toHaveLength(2);
});

it('画像下载明确选择 Laya，不改写当前意图资源', async () => {
  fixture.selected = 'QWeQ-NineBird-v1';
  await getIntentSenseLocalEngine().download({ modelId: 'laya-multilingual', mirror: false });
  expect(downloadLayaBundle).toHaveBeenCalledWith(
    expect.objectContaining({
      destDir: expect.stringContaining('laya-multilingual'),
      mirror: false,
    }),
  );
  expect(fixture.selected).toBe('QWeQ-NineBird-v1');
});

it('画像资源空闲五分钟后释放，下次推断按原资源重新启动', async () => {
  vi.useFakeTimers();
  const engine = getIntentSenseLocalEngine().forModel!('laya-multilingual');
  await engine.analyze('合成输入');
  expect(fixture.loaded).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await engine.analyze('空闲后的合成输入');
  expect(fixture.loaded).toHaveLength(2);
  expect(fixture.loaded[1]).toBe(fixture.loaded[0]);
});
