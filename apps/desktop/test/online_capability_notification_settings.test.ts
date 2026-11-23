import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';
import {
  normalizeNotificationEvents,
  type NotificationEvents,
} from '@weq/service/notification-settings';
import { chooseFormOption } from './support/form-controls';

const fixture = vi.hoisted(() => ({
  notificationEvents: undefined as NotificationEvents | undefined,
  mutate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.includes('getSettings')
                ? { autoAttachQq: true, notificationEvents: fixture.notificationEvents }
                : undefined,
              isLoading: false,
              refetch: vi.fn(),
            })
          : key === 'useMutation'
            ? () => ({ mutateAsync: fixture.mutate, isPending: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mutate.mockReset();
  fixture.notificationEvents = normalizeNotificationEvents(undefined);
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(AccountBasicsSection)));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('受限通知方式写入统一配置，保存失败保留原方式', async () => {
  fixture.mutate.mockImplementation(
    async ({ channels }: { channels: NotificationEvents['runtime'] }) => {
      fixture.notificationEvents = { ...fixture.notificationEvents!, runtime: channels };
      return fixture.notificationEvents;
    },
  );
  const f = mount();
  const select = f.host.querySelector<HTMLButtonElement>(
    '[aria-label="功能受限或运行异常通知方式"]',
  )!;
  const choose = (value: string) => {
    chooseFormOption(select, value);
  };
  try {
    expect(select.dataset.value).toBe('banner');
    await act(async () => choose('off'));
    expect(select.dataset.value).toBe('off');
    expect(fixture.mutate).toHaveBeenCalledWith({
      events: ['runtime'],
      channels: { banner: false, system: false },
    });
    fixture.mutate.mockRejectedValueOnce(new Error('合成保存失败'));
    await act(async () => choose('banner'));
    expect(select.dataset.value).toBe('off');
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成保存失败');
  } finally {
    f.close();
  }
});
