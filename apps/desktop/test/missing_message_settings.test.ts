import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissingMessageSettings } from '../src/renderer/src/components/settings/MissingMessageSettings';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';

vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { clientState: { patch: { mutate: vi.fn() } } },
}));
let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('缺失消息设置联动', () => {
  it('仅在上级条件成立时展示，隐藏后保留原取值', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    let revision = 0;
    const update = (automatic: boolean, context: boolean) =>
      act(() =>
        acceptPreferences(
          {
            epoch: 'missing-settings',
            revision: ++revision,
            records: {},
            values: {
              autoFetchMissingMessages: automatic,
              autoFetchMissingContext: context,
              missingMessageContextCount: 80,
            },
          },
          false,
        ),
      );
    update(false, false);
    await act(async () => root.render(h(MissingMessageSettings)));
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(container.querySelector('input')).toBeNull();
    update(false, true);
    expect(container.querySelector('input')?.value).toBe('80');
    update(true, true);
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(container.querySelector('input')).toBeNull();
    update(false, true);
    expect(container.querySelector('input')?.value).toBe('80');
  });
});
