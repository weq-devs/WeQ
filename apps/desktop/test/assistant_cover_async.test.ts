import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  png: Buffer.from('synthetic-png'),
}));
const render = vi.hoisted(() => vi.fn(async () => state.png));
const create = vi.hoisted(() => vi.fn(() => ({ run: render })));
vi.mock('../src/main/image_processor', () => ({ createImageProcessor: create }));
import { renderCardPng } from '../src/main/weq_assistant/cover';
import { setWeqTheme } from '../src/main/weq_assistant/theme';

it('封面在专用子进程渲染，主进程只传递尺寸、内容与当前主题快照', async () => {
  setWeqTheme({ mode: 'dark', accent: '#00a389' });
  const spec = { title: '合成封面', width: 400, height: 200 };
  expect(await renderCardPng(spec)).toEqual(state.png);
  expect(create).toHaveBeenCalledWith({ workerName: 'coverWorker.mjs', timeoutMs: 90_000 });
  expect(render).toHaveBeenCalledWith({
    operation: 'cover',
    spec: { ...spec, theme: { mode: 'dark', accent: '#00a389' } },
  });
  const override = { mode: 'light' as const, accent: '#336699' };
  await renderCardPng({ ...spec, theme: override });
  expect(render).toHaveBeenLastCalledWith({
    operation: 'cover',
    spec: { ...spec, theme: override },
  });
});
