// @vitest-environment node
import { expect, test, vi } from 'vitest';
const io = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: io.execFile, spawn: vi.fn() }));
import { runningQqCount } from '../src/main/qq_launch';

test('精确 QQ 主进程存在只返回运行数；非 macOS 不猜进程名', async () => {
  io.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(null, '123\n123\n456\n', ''),
  );
  expect(await runningQqCount('darwin')).toBe(2);
  expect(io.execFile).toHaveBeenCalledWith(
    '/usr/bin/pgrep',
    ['-x', 'QQ'],
    expect.objectContaining({ timeout: 1000 }),
    expect.any(Function),
  );
  io.execFile.mockClear();
  expect(await runningQqCount('win32')).toBeNull();
  expect(io.execFile).not.toHaveBeenCalled();
});
test('无匹配、超时、异常输出不混为同一个零值', async () => {
  io.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback({ code: 1 }, '', ''),
  );
  expect(await runningQqCount('darwin')).toBe(0);
  io.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback({ code: 'ETIMEDOUT' }, '', ''),
  );
  expect(await runningQqCount('darwin')).toBeNull();
  io.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(null, 'invalid', ''),
  );
  expect(await runningQqCount('darwin')).toBeNull();
});
