import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('旧媒体预览文件已删除，应用只挂载统一宿主', () => {
  const renderer = resolve(import.meta.dirname, '../src/renderer/src');
  for (const name of ['ImageLightbox', 'VideoLightbox', 'QzoneMediaPreview'])
    expect(existsSync(resolve(renderer, `components/${name}.tsx`)), name).toBe(false);
  const app = readFileSync(resolve(renderer, 'App.tsx'), 'utf8');
  expect(app.match(/<MediaPreviewHost\s*\/>/g)).toHaveLength(1);
});
