import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  StructuredExportControls,
  structuredExportOptions,
} from '../src/renderer/src/views/export/StructuredExportControls';

describe('结构化导出兼容入口', () => {
  it('现有导出页面可继续加载组件，并沿用统一策略而不显示旧选项', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(StructuredExportControls, {
        options: { profile: 'basic', incrementalSupport: false },
        formats: ['json'],
        disabled: true,
        onChange,
      }),
    );
    expect(html).toContain('仅 json/jsonl 支持增量导出');
    expect(html).not.toContain('<input');
    expect(onChange).not.toHaveBeenCalled();
    expect(structuredExportOptions({}, ['json'])).toEqual({
      profile: 'full',
      incrementalSupport: true,
    });
  });
});
