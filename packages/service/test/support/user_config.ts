import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../../src/bootstrap/user_config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function configFixture(raw?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'weq-config-test-'));
  roots.push(root);
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  const write = (value: unknown) => writeFileSync(join(root, 'config.json'), JSON.stringify(value));
  if (raw !== undefined) write(raw);
  const open = () => new UserConfigService(platform);
  return { root, platform, write, open, service: open() };
}
