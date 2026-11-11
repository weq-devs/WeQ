// @vitest-environment node
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { procedure, router } from '../src/main/ipc/trpc';
import { createWebHost } from '../src/main/web/host';

it('Remote 入口拒绝电脑操作；同宽电脑请求、普通业务请求不受影响', async () => {
  const action = vi.fn(() => 'ok');
  const app = router({
    bootstrap: router({
      pickCacheDir: procedure.mutation(action),
      setCallRecording: procedure
        .input(z.object({ mode: z.string().optional(), dir: z.string().optional() }))
        .mutation(action),
      backupBeginUpload: procedure.mutation(action),
    }),
  });
  const host = createWebHost({ exportDir: tmpdir(), version: 'test' });
  const remote = app.createCaller({ host: { ...host, remoteClient: true } });
  await expect(remote.bootstrap.pickCacheDir()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(remote.bootstrap.setCallRecording({ dir: '/computer' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(action).not.toHaveBeenCalled();
  expect(await remote.bootstrap.setCallRecording({ mode: 'mixed' })).toBe('ok');
  expect(await remote.bootstrap.backupBeginUpload()).toBe('ok');
  expect(await app.createCaller({ host }).bootstrap.pickCacheDir()).toBe('ok');
});
