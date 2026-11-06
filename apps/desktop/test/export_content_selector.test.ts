import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EXPORT_CONTENT_DETAILS, selectAllExportContent } from '@weq/service/export-content';
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
      '消息导出方式',
      '语音导出方式',
    ]);
    expect(groups.at(-1)?.getAttribute('aria-label')).toBe('联系人或群资料导出方式');
    expect(root.querySelector('[aria-label="展开附加数据明细"]')).toBeNull();
    expect(root.querySelector('[aria-label="展开联系人或群资料明细"]')).toBeNull();
    const additional = root.querySelector('[role="group"][aria-label="附加数据"]');
    const buttons = [...(additional?.querySelectorAll('button') ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([
      '属性信息',
      '协议与未解析数据',
      '其他已存版本',
    ]);
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(additional?.querySelector('[role="radiogroup"]')).toBeNull();
    expect(additional?.textContent).not.toMatch(/不导出|仅本地/);
    expect(additional?.closest('.is-detail')).not.toBeNull();
    expect(additional?.closest('.weq-export-content-group')).toBe(
      groups[0]?.closest('.weq-export-content-group'),
    );
  });
  it('附加数据全选时亮起并显示勾号，导出中禁用按钮', () => {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(
      createElement(ExportContentSelector, {
        value: selectAllExportContent('local'),
        onChange: vi.fn(),
        disabled: true,
      }),
    );
    const buttons = root.querySelectorAll('[role="group"][aria-label="附加数据"] button');
    for (const button of buttons) {
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.classList.contains('is-on')).toBe(true);
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.hasAttribute('disabled')).toBe(true);
    }
  });
  it('同类子项目独立切换，展开后的按钮只修改当前内容明细', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const onChange = vi.fn();
    const value = selectAllExportContent('none');
    try {
      await act(async () => root.render(createElement(ExportContentSelector, { value, onChange })));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('.weq-exp-format')];
      await act(async () => buttons.find((button) => button.textContent === '属性信息')?.click());
      const selected = onChange.mock.lastCall?.[0];
      for (const detail of EXPORT_CONTENT_DETAILS)
        expect(selected.details[detail.key]).toBe(
          detail.key.endsWith('Properties') ? 'local' : 'none',
        );
      expect(selected.images).toBe('none');
      await act(async () =>
        root.render(createElement(ExportContentSelector, { value: selected, onChange })),
      );
      const properties = buttons.find((button) => button.textContent === '属性信息');
      expect(properties?.getAttribute('aria-pressed')).toBe('true');
      await act(async () => properties?.click());
      expect(onChange.mock.lastCall?.[0]).toEqual(value);
      const legacy = {
        ...value,
        details: { ...value.details, messageProperties: 'local' as const },
      };
      await act(async () =>
        root.render(createElement(ExportContentSelector, { value: legacy, onChange })),
      );
      expect(properties?.getAttribute('aria-pressed')).toBe('mixed');
      await act(async () => properties?.click());
      expect(onChange.mock.lastCall?.[0]).toEqual(selected);
      await act(async () => root.render(createElement(ExportContentSelector, { value, onChange })));
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="展开图片明细"]')?.click(),
      );
      const imageDetails = host.querySelector('[id$="-images"]');
      expect(imageDetails?.querySelector('[role="radiogroup"]')).toBeNull();
      await act(async () => imageDetails?.querySelector<HTMLButtonElement>('button')?.click());
      expect(onChange.mock.lastCall?.[0].details).toEqual({
        ...value.details,
        imageProperties: 'local',
      });
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it('传输层将旧预设中的资料明细迁移到独立项目', () => {
    const { profiles: _profiles, ...legacy } = selectAllExportContent('none');
    const parsed = exportContentPolicyInput.parse({ ...legacy, details: { profiles: 'local' } });
    expect(parsed.profiles).toBe('local');
    expect(parsed.details).not.toHaveProperty('profiles');
  });
});
