import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { UserConfigService } from '../src/bootstrap/user_config';
import { onSettingsChanged } from '../src/common/settings_changes';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-settings-events-'));
  roots.push(root);
  return { root, config: new UserConfigService({ appDataRoot: () => root }) };
}
it('真实配置写入与恢复重读都通知，读取者得到已持久化的新值', () => {
  const { root, config } = fixture();
  const values: boolean[] = [];
  const stop = onSettingsChanged(() => values.push(config.getSettings().renderTextMarkdown));
  try {
    config.setSettings({ renderTextMarkdown: false });
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        ...config.read(),
        settings: { ...config.getSettings(), renderTextMarkdown: true },
      }),
    );
    config.reload();
    expect(values).toEqual([false, true]);
  } finally {
    stop();
  }
});
it('真实配置落盘失败时不发布设置已变更通知', () => {
  const { root, config } = fixture();
  config.setSettings({ renderTextMarkdown: true });
  rmSync(join(root, 'config.json'));
  mkdirSync(join(root, 'config.json'));
  let notifications = 0;
  const stop = onSettingsChanged(() => notifications++);
  try {
    expect(() => config.setSettings({ renderTextMarkdown: false })).toThrow();
    expect(notifications).toBe(0);
  } finally {
    stop();
  }
});
