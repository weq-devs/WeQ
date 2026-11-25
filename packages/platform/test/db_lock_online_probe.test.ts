import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeBundle } from '@weq/native';
import { expect, it, vi } from 'vitest';
import { createLinuxPlatform, createWin32Platform, linuxAccountDirName } from '../src';

it('Windows 和 Linux 的轮询区分确认无人持库与探测失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-online-probe-'));
  const uin = '12345678';
  const uid = 'fixture-uid';
  try {
    for (const [path, platform] of [
      [
        join(root, uin, 'nt_qq', 'nt_db', 'nt_msg.db'),
        (native: NativeBundle) => createWin32Platform(native, () => root),
      ],
      [
        join(root, linuxAccountDirName(uid), 'nt_db', 'nt_msg.db'),
        (native: NativeBundle) =>
          createLinuxPlatform(
            native,
            () => root,
            () => uid,
          ),
      ],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      const probe = vi
        .fn()
        .mockReturnValueOnce({ success: true, holders: [{ name: 'QQ', pid: 87 }] })
        .mockReturnValueOnce({ success: true, holders: [] })
        .mockReturnValueOnce({ success: false, msg: 'probe unavailable', holders: [] })
        .mockImplementation(() => {
          throw new Error('probe threw');
        });
      const native = { ntHelper: { probeDbLock: probe } } as unknown as NativeBundle;
      const instance = platform(native);
      await expect(instance.resolveQqPidAsync!(uin)).resolves.toBe(87);
      await expect(instance.resolveQqPidAsync!(uin)).resolves.toBeNull();
      await expect(instance.resolveQqPidAsync!(uin)).rejects.toThrow('probe unavailable');
      await expect(instance.resolveQqPidAsync!(uin)).rejects.toThrow('probe threw');
      expect(instance.resolveQqPid(uin)).toBeNull();
      expect(probe).toHaveBeenCalledWith(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
