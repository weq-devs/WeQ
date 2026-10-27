// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const { load } = appBuilderRequire('js-yaml') as { load: (source: string) => unknown };
interface Job {
  permissions?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, unknown> }[];
}
const workflow = load(
  readFileSync(resolve(__dirname, '../../../.github/workflows/release.yml'), 'utf8'),
) as {
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

it('发布工作流默认只读，只有实际发布产物或说明的 job 可写', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const writers = [
    'prepare',
    'publish',
    'windows',
    'linux-x64',
    'linux-arm64',
    'macos-x64',
    'macos-arm64',
    'mac-merge-update-info',
    'web',
    'notes',
  ];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    expect(job.permissions ?? workflow.permissions, name).toEqual({
      contents: writers.includes(name) ? 'write' : 'read',
    });
  }
});

it('两个 QQ 通知分支均固定完整提交，保留消息、附件和显式凭据输入', () => {
  const steps = (workflow.jobs['qq-notify']?.steps ?? []).filter((step) =>
    step.uses?.startsWith('H3CoF6/qq-notify-action@'),
  );
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    expect(step.uses).toMatch(/^H3CoF6\/qq-notify-action@[0-9a-f]{40}$/);
    expect(step.with?.appid).toMatch(/^\$\{\{\s*secrets\.QQ_APPID\s*\}\}$/);
    expect(step.with?.secret).toMatch(/^\$\{\{\s*secrets\.QQ_SECRET\s*\}\}$/);
    expect(step.with?.group_openid).toMatch(/^\$\{\{\s*secrets\.QQ_GROUP_OPENID\s*\}\}$/);
    expect(step.with?.message).toContain('steps.prep.outputs.body');
  }
  expect(steps[0]!.uses).toBe(steps[1]!.uses);
  expect(steps[0]!.with?.file_path).toContain('steps.prep.outputs.pkg');
  expect(steps[1]!.with?.file_path).toBeUndefined();
});
