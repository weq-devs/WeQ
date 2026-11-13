import { expect, it, vi } from 'vitest';
import {
  createQqRuntimeModuleProbe,
  parseQqRuntimeModules,
} from '../src/darwin/runtime_module_probe';

const row = (pid: number, paths: string[]) =>
  `p${pid}\0${paths.map((path) => `ftxt\0n${path}\0`).join('')}\n`;
const first = ['/fixture/hot-update/wrapper.node', '/fixture/hot-update/major.node'];

it('目标 PID 的同一组映射去重，Unicode 路径不按行或空格拆分', () => {
  const paths = ['/fixture/中文 路径/wrapper.node', '/fixture/中文 路径/major.node'];
  expect(parseQqRuntimeModules(row(42, [...paths, paths[0]!]), 42, (path) => path)).toEqual({
    wrapperPath: paths[0],
    majorPath: paths[1],
  });
});

it('其他 PID、竞争版本、不完整或无法 canonicalize 的映射不混用安装文件', () => {
  for (const data of [
    row(43, first),
    row(42, [first[0]!]),
    row(42, [...first, '/fixture/other/wrapper.node']),
    row(42, [first[0]!]) + '\n' + row(43, [first[1]!]),
  ])
    expect(() => parseQqRuntimeModules(data, 42, (path) => path)).toThrow('无法确认');
  expect(() =>
    parseQqRuntimeModules(row(42, first), 42, () => {
      throw new Error('missing image');
    }),
  ).toThrow('missing image');
});

it('合并同 PID 在途探测，完成或失败后可重新查询', async () => {
  let release!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const probe = createQqRuntimeModuleProbe(read, (path) => path);
  const a = probe(42),
    b = probe(42);
  expect(a).toBe(b);
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  release(row(42, first));
  await expect(a).resolves.toEqual({ wrapperPath: first[0], majorPath: first[1] });
  read.mockRejectedValueOnce(new Error('probe failed'));
  await expect(probe(42)).rejects.toThrow('probe failed');
  const next = probe(42);
  await Promise.resolve();
  release(row(42, first));
  await next;
});
