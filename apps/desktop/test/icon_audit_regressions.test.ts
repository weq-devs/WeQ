import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Download, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsRetry } from '../src/renderer/src/components/AnalyticsRetry';
import { VirtualConversationBadge } from '../src/renderer/src/components/VirtualConversationAvatar';
import { ExportContentSelector } from '../src/renderer/src/views/export/ExportContentSelector';
import { DRESS_KIND_ICONS, FEATURE_ICONS } from '../src/renderer/src/lib/featureIcons';
import { SEARCH_CATEGORY_ICONS } from '../src/renderer/src/components/search/searchIcons';
import { QzoneForwardDialog } from '../src/renderer/src/components/QzoneForwardDialog';
import { BackgroundTaskActionIcon } from '../src/renderer/src/components/tasks/BackgroundTaskDetails';

const state = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/trpc/client')>();
  return { ...actual, client: { bootstrap: { getSettings: { query: state.settings } } } };
});

function render(element: React.ReactElement) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

function shape(Icon: ComponentType<{ size?: number }>) {
  return render(createElement(Icon)).querySelector('svg')!.innerHTML;
}

describe('图标审计回归', () => {
  it('群功能在搜索与内容入口复用同一图标', () => {
    expect(SEARCH_CATEGORY_ICONS.groupEssence).toBe(FEATURE_ICONS.groupEssence);
    expect(SEARCH_CATEGORY_ICONS.groupAlbum).toBe(FEATURE_ICONS.groupAlbum);
    expect(SEARCH_CATEGORY_ICONS.groupFile).toBe(FEATURE_ICONS.groupFile);
  });

  it('导出内容中的消息、气泡和挂件图标同义统一、异义可辨', () => {
    const host = render(createElement(ExportContentSelector, { value: {}, onChange: vi.fn() }));
    const iconFor = (label: string) =>
      [...host.querySelectorAll('.weq-export-content-label')]
        .find((row) => row.textContent?.trim() === label)!
        .querySelector(':scope > svg')!.innerHTML;
    expect(iconFor('消息')).toBe(shape(FEATURE_ICONS.messages));
    expect(iconFor('装扮气泡')).toBe(shape(DRESS_KIND_ICONS.bubble));
    expect(iconFor('头像挂件')).toBe(shape(DRESS_KIND_ICONS.widget));
    expect(iconFor('消息')).not.toBe(iconFor('装扮气泡'));
    expect(iconFor('头像挂件')).not.toBe(shape(FEATURE_ICONS.assistant));
  });

  it('克隆身份角标与克隆导航一致，不冒用助手或频道私聊图标', () => {
    for (const group of [false, true]) {
      const host = render(createElement(VirtualConversationBadge, { group }));
      expect(host.querySelector('svg')!.innerHTML).toBe(
        shape(group ? FEATURE_ICONS.cloneGroup : FEATURE_ICONS.clone),
      );
      expect(host.querySelector('svg')!.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    expect(shape(FEATURE_ICONS.cloneGroup)).not.toBe(shape(FEATURE_ICONS.guildDirect));
  });

  it('读取重试使用刷新图标，并保留可访问名称', () => {
    const retry = vi.fn();
    const host = render(createElement(AnalyticsRetry, { error: '读取失败', onRetry: retry }));
    expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('重试分析');
    expect(host.querySelector('svg')!.innerHTML).toBe(shape(RefreshCw));
    expect(host.querySelector('svg')!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('任务快捷操作与详情共用操作图标，下载、暂停和继续不再误用文件夹', () => {
    for (const [id, Icon] of [
      ['download', Download],
      ['pause', Pause],
      ['resume', Play],
      ['continue', Play],
      ['retry', RefreshCw],
      ['stop', Square],
      ['cancel', Square],
    ] as const) {
      const icon = render(createElement(BackgroundTaskActionIcon, { id })).querySelector('svg')!;
      expect(icon.innerHTML, id).toBe(shape(Icon));
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('空间转发读取失败时与提交操作一样提供图标，重试仍只重新读取', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    state.settings
      .mockReset()
      .mockRejectedValueOnce(new Error('合成读取失败'))
      .mockResolvedValue({});
    const submit = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(
            QzoneForwardDialog,
            { previousContent: '合成动态', onClose: vi.fn(), submit },
            '合成正文',
          ),
        ),
      );
      const retry = document.querySelector<HTMLButtonElement>('.weq-qzn-error button')!;
      expect(retry.textContent?.trim()).toBe('重试');
      expect(retry.classList.contains('weq-retry-button')).toBe(true);
      expect(retry.querySelector('svg')!.innerHTML).toBe(shape(RefreshCw));
      expect(retry.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
      await act(async () => retry.click());
      expect(state.settings).toHaveBeenCalledTimes(2);
      expect(document.querySelector<HTMLTextAreaElement>('[aria-label="转发语"]')!.disabled).toBe(
        false,
      );
      expect(submit).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
