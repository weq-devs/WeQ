import { describe, expect, it } from 'vitest';
import { runOwnedChild } from '../src/common/owned_child';

describe('owned worker lifecycle', () => {
  it('collects an ordinary worker output without a shell', async () => {
    const result = await runOwnedChild(process.execPath, [
      '-e',
      'process.stdout.write("fixture"); process.stderr.write("diagnostic")',
    ]);
    expect(result).toMatchObject({ code: 0, stdout: 'fixture', stderr: 'diagnostic' });
  });
  it('times out its own worker and waits for close', async () => {
    await expect(
      runOwnedChild(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 100 }),
    ).rejects.toThrow('超时');
  });
  it('cancels its own worker without exposing sensitive stdin', async () => {
    const controller = new AbortController();
    const request = runOwnedChild(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      input: 'synthetic-secret',
      signal: controller.signal,
    });
    controller.abort(new Error('user cancelled'));
    await expect(request).rejects.toThrow('user cancelled');
  });
  it('bounds output and handles a failed spawn', async () => {
    await expect(
      runOwnedChild(
        process.execPath,
        ['-e', 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'],
        { maxOutputBytes: 10 },
      ),
    ).rejects.toThrow('超过限制');
    await expect(runOwnedChild('/nonexistent-weq-test-worker', [])).rejects.toBeDefined();
  });
});
