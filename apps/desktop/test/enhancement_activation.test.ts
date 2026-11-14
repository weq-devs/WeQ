// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  withEnhancementEngine,
  enhancementEngineBusy,
  blockEnhancementEngineUse,
} from '../src/main/enhancements/engine_environment';

it('切换期间阻止新推理开始，已有推理完成后再发布活动资源', async () => {
  let finish = () => {};
  const old = withEnhancementEngine(
    'onnx',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  expect(enhancementEngineBusy('onnx')).toBe(true);
  const unlock = blockEnhancementEngineUse(['onnx']);
  const start = vi.fn(async () => 'new');
  const next = withEnhancementEngine('onnx', start);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  finish();
  await old;
  expect(enhancementEngineBusy('onnx')).toBe(false);
  unlock();
  expect(await next).toBe('new');
  expect(start).toHaveBeenCalledOnce();
});
