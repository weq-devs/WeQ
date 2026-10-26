import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InteractionProfileSection } from '../src/renderer/src/components/settings/InteractionProfileSection';
import { DEFAULT_INTENT_TUNING } from '@weq/service/intent-context';
import { AI_SETTING_ITEMS } from '../src/renderer/src/components/settings/aiSettingsCatalog';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

const fixture = vi.hoisted(() => ({
  mode: 'api',
  pending: false,
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  localEnabled: false,
  localAvailable: true,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        intentSense: {
          getStatus: { setData: fixture.setData },
          getProfile: { invalidate: fixture.invalidate },
        },
      },
    }),
    bootstrap: {
      getAgentLabDefaultModel: { useQuery: () => ({ data: { ref: null, available: false } }) },
      downloadLocalModel: { useMutation: () => ({ isLoading: false }) },
      listAgentLabProviders: {
        useQuery: () => ({
          data: [{ id: 'synthetic', name: '合成服务', models: [{ id: 'profile-model' }] }],
        }),
      },
      getLocalEngine: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          fixture.localEnabled = options.enabled;
          return {
            data: {
              available: fixture.localAvailable,
              models: [
                { id: 'auto', name: '自动', downloaded: true },
                { id: 'laya-multilingual', name: 'Laya', downloaded: true },
              ],
            },
          };
        },
      },
    },
    account: {
      intentSense: {
        getStatus: {
          useQuery: () => ({
            data: {
              ...DEFAULT_INTENT_TUNING,
              profileEnabled: true,
              profileEngine: fixture.mode,
              profileProviderRef: null,
              profileLocalModelId: 'auto',
            },
          }),
        },
        setConfig: {
          useMutation: () => ({ mutateAsync: fixture.save, isLoading: fixture.pending }),
        },
      },
    },
  },
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mode = 'api';
  fixture.pending = false;
  fixture.localAvailable = true;
  fixture.save.mockReset().mockResolvedValue({});
  fixture.setData.mockClear();
  fixture.invalidate.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(InteractionProfileSection)));
}
async function select(label: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('画像 API 只保存画像引用，运行方式不再包含跟随选项', async () => {
  await render();
  expect(document.body.textContent).not.toContain('跟随意图感知');
  await select('互动画像 API 模型', JSON.stringify(['synthetic', 'profile-model']));
  expect(fixture.save).toHaveBeenCalledWith({
    profileProviderRef: { providerId: 'synthetic', model: 'profile-model' },
  });
  expect(fixture.invalidate).toHaveBeenCalledOnce();
});

it('画像本地资源独立选择，在途时禁用控件', async () => {
  fixture.mode = 'local';
  await render();
  await select('互动画像本地模型资源', 'laya-multilingual');
  expect(fixture.save).toHaveBeenCalledWith({ profileLocalModelId: 'laya-multilingual' });
  fixture.pending = true;
  await render();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="互动画像本地模型资源"]')!.disabled,
  ).toBe(true);
});
it('宿主不支持本地画像模型时禁用选择并显示原因，不误提交', async () => {
  fixture.mode = 'local';
  fixture.localAvailable = false;
  await render();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="互动画像本地模型资源"]')!.disabled,
  ).toBe(true);
  expect(document.body.textContent).toContain('当前宿主不支持本地画像模型');
  expect(fixture.save).not.toHaveBeenCalled();
});

it.each(['api', 'local', 'heuristic'])(
  '%s 下全部画像参数可由稳定 ID 搜索，非本地模式不查模型资源',
  async (mode) => {
    fixture.mode = mode;
    await render();
    expect(fixture.localEnabled).toBe(mode === 'local');
    for (const item of AI_SETTING_ITEMS.filter((item) => item.section === 'interaction-profile')) {
      expect(document.querySelectorAll(`[data-setting-id="${item.id}"]`), item.id).toHaveLength(1);
      expect(
        searchAppEntries(item.label).some(
          (entry) => entry.target.kind === 'setting' && entry.target.settingId === item.id,
        ),
        item.id,
      ).toBe(true);
    }
    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      const details = document.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(submit.disabled).toBe(false);
    expect(fixture.save).not.toHaveBeenCalled();
  },
);
