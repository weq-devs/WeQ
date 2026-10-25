// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(path)
        ? [readFileSync(path, 'utf8')]
        : [];
  });
}
it('所有通用保存入口不再提供另存下拉菜单或临时保存模式控件', () => {
  const text = sources(join(__dirname, '../src/renderer/src')).join('\n');
  expect(text).not.toContain('<ExportSaveActions');
  expect(text).not.toContain('weq-save-options');
  expect(text).not.toContain('<ExportSaveControl');
});
