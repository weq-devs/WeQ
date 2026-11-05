import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { selectAllExportContent } from '@weq/service/export-content';
import { ExportContentSelector } from '../src/renderer/src/views/export/ExportContentSelector';
import { exportContentPolicyInput } from '../src/shared/export_content';

describe('导出内容列表结构', () => {
  it('附加数据紧跟全部、常显且无折叠按钮；资料独立放到末尾', () => {
    const markup = renderToStaticMarkup(
      createElement(ExportContentSelector, {
        value: selectAllExportContent('none'),
        onChange: vi.fn(),
      }),
    );
    const root = document.createElement('div');
    root.innerHTML = markup;
    const groups = [...root.querySelectorAll('[role="radiogroup"]')];
    expect(groups.slice(0, 3).map((group) => group.getAttribute('aria-label'))).toEqual([
      '全部导出方式',
      '附加数据导出方式',
      '消息导出方式',
    ]);
    expect(groups.at(-1)?.getAttribute('aria-label')).toBe('联系人或群资料导出方式');
    expect(root.querySelector('[aria-label="展开附加数据明细"]')).toBeNull();
    expect(root.querySelector('[aria-label="展开联系人或群资料明细"]')).toBeNull();
    expect(groups[1]?.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(groups[1]?.closest('.is-detail')).not.toBeNull();
    expect(groups[1]?.closest('.weq-export-content-group')).toBe(
      groups[0]?.closest('.weq-export-content-group'),
    );
  });
  it('传输层将旧预设中的资料明细迁移到独立项目', () => {
    const { profiles: _profiles, ...legacy } = selectAllExportContent('none');
    const parsed = exportContentPolicyInput.parse({ ...legacy, details: { profiles: 'local' } });
    expect(parsed.profiles).toBe('local');
    expect(parsed.details).not.toHaveProperty('profiles');
  });
});
