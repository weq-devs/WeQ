// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const oldTerms = /完整(?:功能|体验)/;
const extensions = new Set(['.ts', '.tsx', '.md', '.html', '.mjs', '.json']);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : extensions.has(extname(path)) ? [path] : [];
  });
}

it('在线能力的运行提示与帮助不使用退役名称', () => {
  const found = ['apps/desktop/src', 'apps/web/src', 'packages/service/src', 'resources/help']
    .flatMap((directory) => files(join(root, directory)))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          oldTerms.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
        ),
    );
  expect(found).toEqual([]);
});
