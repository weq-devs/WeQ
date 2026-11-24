import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataSaverSession, networkCost, UNKNOWN_NETWORK } from '@weq/service/data-saver';
import { DataSaverMenu } from '../src/renderer/src/components/DataSaverMenu';
import { DataSaverSettings } from '../src/renderer/src/components/settings/DataSaverSettings';
import { applyDataSaverStatus, useDataSaver } from '../src/renderer/src/lib/dataSaver';
import { acceptPreferences, useClientPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { OPEN_SETTINGS_COMMAND } from '../src/renderer/src/lib/callSettingsBridge';

const fixture = vi.hoisted(() => ({
  session: null as DataSaverSession | null,
  revision: 0,
  fail: false,
  preferences: { dataSaverMode: 'auto' as 'auto' | 'always' | 'never', dataSaverOnMetered: false },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    settings: {
      dataSaver: {
        status: { query: async () => fixture.session!.status() },
        temporary: {
          mutate: async ({ value }: { value: Parameters<DataSaverSession['setTemporary']>[0] }) => {
            if (fixture.fail) throw new Error('合成保存失败');
            fixture.session!.setTemporary(value);
            return fixture.session!.status();
          },
        },
        clearTemporary: {
          mutate: async () => {
            fixture.session!.clearTemporary();
            return fixture.session!.status();
          },
        },
      },
    },
    clientState: {
      patch: {
        mutate: async (values: {
          dataSaverMode?: 'auto' | 'always' | 'never';
          dataSaverOnMetered?: boolean;
        }) => {
          if (fixture.fail) throw new Error('合成保存失败');
          Object.assign(fixture.preferences, values);
          fixture.session!.update(
            fixture.preferences.dataSaverMode,
            fixture.session!.status().host,
            fixture.preferences.dataSaverOnMetered,
          );
          fixture.session!.clearTemporary('settings');
          return {
            epoch: 'menu-fixture',
            revision: ++fixture.revision,
            values: { ...fixture.preferences },
            records: {},
          };
        },
      },
    },
  },
}));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.session = new DataSaverSession();
  fixture.fail = false;
  fixture.preferences = { dataSaverMode: 'auto', dataSaverOnMetered: false };
  acceptPreferences(
    {
      epoch: 'menu-fixture',
      revision: ++fixture.revision,
      values: { dataSaverMode: 'auto', dataSaverOnMetered: false },
      records: {},
    },
    false,
  );
  useDataSaver.setState({
    enabled: false,
    host: UNKNOWN_NETWORK,
    local: UNKNOWN_NETWORK,
    status: null,
  });
  useClientPreferences.setState({ error: '' });
  useToast.setState({ toasts: [], leaving: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fixture.session!.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function click(name: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === name || button.textContent === name,
  );
  expect(element, name).toBeTruthy();
  await act(async () => element!.click());
}
async function mountMenu() {
  applyDataSaverStatus(fixture.session!.status());
  await act(async () => root.render(createElement(DataSaverMenu)));
}

it('自动进入退出提醒去重，未知探测不退出，手动操作不产生横幅', () => {
  fixture.session!.update('auto', networkCost(true, false, 'fixture'));
  applyDataSaverStatus(fixture.session!.status());
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts).toHaveLength(1);
  const entry = useToast.getState().toasts[0];
  expect(entry.event).toBe('dataSaver');
  expect(useDataSaver.getState().enabled).toBe(true);
  fixture.session!.update('auto', UNKNOWN_NETWORK);
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts[0]).toBe(entry);
  fixture.session!.update('auto', networkCost(false, false, 'fixture'));
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts[0].title).not.toBe(entry.title);
  expect(useDataSaver.getState().enabled).toBe(false);
  const staleNotice = useToast.getState().toasts[0].id;
  fixture.session!.setTemporary({ enabled: true, duration: 'exit' });
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts).toHaveLength(1);
  expect(useToast.getState().leaving).toEqual([staleNotice]);
});
it('临时期满恢复基础模式并显示横幅，迟到的旧状态不能覆盖', async () => {
  vi.useFakeTimers();
  fixture.session!.update('auto', networkCost(true, false, 'fixture'));
  fixture.session!.setTemporary({ enabled: false, duration: 'minutes', minutes: 1 });
  const old = fixture.session!.status();
  applyDataSaverStatus(old);
  await vi.advanceTimersByTimeAsync(60000);
  applyDataSaverStatus(fixture.session!.status());
  applyDataSaverStatus(old);
  expect(useDataSaver.getState().enabled).toBe(true);
  const notice = useToast.getState().toasts[0];
  expect(Reflect.get(notice, 'summary') ?? notice.detail).toBe('临时设置已到期');
});
it('首次确认跟随系统开启时提醒，不受之前的手动设置原因影响', () => {
  fixture.session!.update('never', networkCost(true, false, 'fixture'));
  fixture.session!.update('auto', networkCost(true, false, 'fixture'));
  expect(fixture.session!.status().reason).toBe('settings');
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts[0].event).toBe('dataSaver');
  expect(useDataSaver.getState().enabled).toBe(true);
});
it('计费触发初次提醒说明实际原因，默认关闭时不弹自动开启提醒', () => {
  const cost = networkCost(false, true, 'fixture');
  fixture.session!.update('auto', cost);
  applyDataSaverStatus(fixture.session!.status());
  expect(useToast.getState().toasts).toHaveLength(0);
  useDataSaver.setState({ status: null });
  fixture.session!.update('auto', cost, true);
  applyDataSaverStatus(fixture.session!.status());
  const notice = useToast.getState().toasts[0];
  expect(Reflect.get(notice, 'summary') ?? notice.detail).toBe('使用流量时自动启用');
});
it.each(['host', 'local'] as const)(
  '入口跟随实际省流量状态，不因 %s 端仅使用流量或系统限制而单独显示',
  async (source) => {
    await mountMenu();
    expect(host.querySelector('button')?.hidden).toBe(true);
    for (const [mode, constrained, metered, onMetered, enabled] of [
      ['auto', false, true, false, false],
      ['never', false, true, true, false],
      ['never', true, true, true, false],
      ['auto', false, true, true, true],
      ['auto', true, false, false, true],
      ['always', false, false, false, true],
      ['auto', false, false, false, false],
    ] as const) {
      await act(async () => {
        const cost = networkCost(constrained, metered, 'fixture');
        fixture.session!.update(mode, source === 'host' ? cost : UNKNOWN_NETWORK, onMetered);
        if (source === 'local') fixture.session!.updateClient('phone', cost);
        const status = fixture.session!.status('phone');
        applyDataSaverStatus(status);
        if (source === 'local') useDataSaver.setState({ local: status.local });
      });
      expect(useDataSaver.getState().enabled).toBe(enabled);
      expect(host.querySelector('button')?.hidden).toBe(!enabled);
    }
  },
);
it('临时关闭提供三种期限，临时开启没有任务期限，支持恢复与设置跳转', async () => {
  fixture.session!.update('always', UNKNOWN_NETWORK);
  fixture.session!.setPendingTasks(2);
  await mountMenu();
  await click('省流量菜单');
  await click('临时关闭');
  expect(document.querySelector('[aria-label="临时省流量期限"]')?.textContent).toContain(
    '直到全部任务完成',
  );
  await click('直到全部任务完成');
  await click('确认临时关闭');
  expect(fixture.session!.status().temporary?.duration).toBe('tasks');
  await click('关闭省流量菜单');
  expect(host.querySelector('button')?.hidden).toBe(false);
  await click('省流量菜单');
  await click('临时开启');
  expect(document.querySelector('[aria-label="临时省流量期限"]')?.textContent).not.toContain(
    '直到全部任务完成',
  );
  await click('恢复基础设置');
  expect(fixture.session!.status().temporary).toBeNull();
  const navigate = vi.fn();
  window.addEventListener(OPEN_SETTINGS_COMMAND, navigate);
  await click('完整设置');
  expect(navigate.mock.calls[0][0].detail.section).toBe('dataSaver');
  expect(document.querySelector('.weq-data-saver-panel')).toBeNull();
  window.removeEventListener(OPEN_SETTINGS_COMMAND, navigate);
});
it('无任务禁用任务期限，分钟数校验及失败保留输入，Escape 关闭', async () => {
  fixture.session!.update('always', UNKNOWN_NETWORK);
  fixture.session!.setPendingTasks(0);
  await mountMenu();
  await click('省流量菜单');
  await click('临时关闭');
  expect(
    [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === '直到全部任务完成',
    )?.disabled,
  ).toBe(true);
  await click('自定义分钟数');
  const input = document.querySelector<HTMLInputElement>('[aria-label="临时省流量分钟数"]')!;
  expect(input.value).toBe('30');
  fixture.fail = true;
  await click('确认临时关闭');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('合成保存失败');
  expect(input.value).toBe('30');
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('.weq-data-saver-panel')).toBeNull();
});
it('两组三选一使用分段选择', async () => {
  await act(async () => root.render(createElement(DataSaverSettings)));
  expect(host.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
  expect(host.querySelector('select')).toBeNull();
});
it('暂停大文件关闭时隐藏阈值，重新开启保留数值，其余省流量配置仍可用', async () => {
  const preferences = (enabled: boolean) =>
    acceptPreferences(
      {
        epoch: 'menu-fixture',
        revision: ++fixture.revision,
        values: { dataSaverMode: 'never', dataSaverPauseLarge: enabled, dataSaverLargeMiB: 37 },
        records: {},
      },
      false,
    );
  preferences(true);
  await act(async () => root.render(createElement(DataSaverSettings)));
  expect(host.querySelector<HTMLInputElement>('[aria-label="大文件暂停阈值"]')?.value).toBe('37');
  await act(async () => {
    preferences(false);
  });
  expect(host.querySelector('[aria-label="大文件暂停阈值"]')).toBeNull();
  expect(host.querySelector('[aria-label="聊天图片自动加载"]')).not.toBeNull();
  await act(async () => {
    preferences(true);
  });
  expect(host.querySelector<HTMLInputElement>('[aria-label="大文件暂停阈值"]')?.value).toBe('37');
});
it('计费选项默认关闭且仅跟随系统显示，设置和菜单共享值，切换模式保留选择', async () => {
  fixture.session!.update('auto', networkCost(false, true, 'fixture'));
  applyDataSaverStatus(fixture.session!.status());
  await act(async () =>
    root.render(
      createElement('div', null, createElement(DataSaverSettings), createElement(DataSaverMenu)),
    ),
  );
  const selector = '[role="switch"][aria-label="使用流量时自动启用"]';
  expect(host.querySelector(selector)?.getAttribute('aria-checked')).toBe('false');
  expect(useDataSaver.getState().enabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('.weq-data-saver-indicator')?.hidden).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  await click('省流量菜单');
  const menuToggle = () =>
    document.querySelector<HTMLButtonElement>(`.weq-data-saver-panel ${selector}`);
  expect(menuToggle()?.getAttribute('aria-checked')).toBe('true');
  await act(async () => menuToggle()!.click());
  expect(useDataSaver.getState().enabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('.weq-data-saver-indicator')?.hidden).toBe(false);
  await act(async () => menuToggle()!.click());
  expect(menuToggle()?.getAttribute('aria-checked')).toBe('true');
  expect(host.querySelector(selector)?.getAttribute('aria-checked')).toBe('true');
  expect(useDataSaver.getState().enabled).toBe(true);
  const modeButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.weq-data-saver-panel [aria-label="省流量基础设置"] [role="radio"]',
    ),
  ];
  for (const mode of ['关闭', '开启']) {
    await act(async () =>
      modeButtons()
        .find((button) => button.textContent === mode)!
        .click(),
    );
    expect(document.querySelectorAll(selector)).toHaveLength(0);
  }
  await act(async () =>
    modeButtons()
      .find((button) => button.textContent === '跟随系统')!
      .click(),
  );
  expect(document.querySelectorAll(selector)).toHaveLength(2);
  expect(menuToggle()?.getAttribute('aria-checked')).toBe('true');
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  expect(menuToggle()?.getAttribute('aria-checked')).toBe('false');
});
