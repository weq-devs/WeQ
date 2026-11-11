import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSave } from '../src/renderer/src/components/settings/AutoSave';
import { useNumericSettingDraft } from '../src/renderer/src/components/settings/useNumericSettingDraft';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots } from '../src/renderer/src/lib/pageSnapshots';
import { flushSettingsSaves, settingsSaves } from '../src/renderer/src/lib/settingsSaveQueue';
import {
  SettingsResetCardContext,
  type ResetSave,
} from '../src/renderer/src/components/settings/resetContext';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => {
    close();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const saved: Record<string, number> = { a: 1, b: 3 };
  const writes: Array<[string, number]> = [];
  const saves = new Set<ResetSave>();
  let current = 'a';
  function Editor({ source }: { source: string }) {
    const [draft, setDraft] = useNumericSettingDraft('value', saved[source]);
    const number = Number(draft);
    return h(
      AutoSave<string | number>,
      {
        value: draft.trim() ? number : '',
        saved: saved[source]!,
        valid: !!draft.trim() && Number.isInteger(number) && number >= 0,
        resetKeys: ['value'],
        reset: () => setDraft(String(saved[source])),
        save: async (value) => {
          writes.push([source, Number(value)]);
          saved[source] = Number(value);
          render(current);
        },
      },
      h('input', {
        value: draft,
        onChange: (event) => setDraft(event.currentTarget.value),
      }),
    );
  }
  function render(source: string) {
    current = source;
    root.render(
      h(
        PageSnapshots,
        { scope: source },
        h(SettingsResetCardContext.Provider, { value: saves }, h(Editor, { source })),
      ),
    );
  }
  act(() => render('a'));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const input = () => host.querySelector('input')!;
  const edit = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  return {
    host,
    input,
    edit,
    writes,
    saves,
    render: (source: string) => act(() => render(source)),
  };
}
it('真实草稿在自动保存后确认，前导零等值编辑不重复提交或拦截离页', async () => {
  const f = fixture();
  f.edit('02');
  expect(pageSnapshots.hasDrafts('a')).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(f.writes).toEqual([['a', 2]]);
  expect(pageSnapshots.hasDrafts('a')).toBe(false);
  f.edit('002');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.writes).toHaveLength(1);
  expect(pageSnapshots.hasDrafts('a')).toBe(false);
});
it('输入法组合期间与回车确认候选时不写入，组合结束后才保存', async () => {
  const f = fixture();
  act(() => f.input().dispatchEvent(new Event('compositionstart', { bubbles: true })));
  f.edit('5');
  await act(async () => {
    f.input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(f.writes).toEqual([]);
  act(() => f.input().dispatchEvent(new Event('compositionend', { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(f.writes).toEqual([['a', 5]]);
});
it('账号和数据源切换取消旧排队，草稿分开保留，恢复草稿不自动提交', async () => {
  const f = fixture();
  f.edit('2');
  f.render('b');
  expect(f.input().value).toBe('3');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.writes).toEqual([]);
  f.render('a');
  expect(f.input().value).toBe('2');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.writes).toEqual([]);
  await act(async () => {
    const flush = flushSettingsSaves();
    await vi.runAllTimersAsync();
    await flush;
  });
  expect(f.writes).toEqual([['a', 2]]);
  expect(pageSnapshots.hasDrafts('a')).toBe(false);
  expect(settingsSaves.size).toBe(1);
});
it('恢复成功撤销旧草稿队列，恢复失败保留可重试草稿且不自动反写', async () => {
  const f = fixture();
  f.edit('2');
  const entry = [...f.saves][0]!;
  await act(async () => {
    await entry.suspend();
    entry.reset();
    entry.release();
  });
  expect(f.input().value).toBe('1');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.writes).toEqual([]);
  f.edit('4');
  await act(async () => {
    await entry.suspend();
    entry.release();
  });
  expect(f.input().value).toBe('4');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.writes).toEqual([]);
  await act(async () => {
    const flush = flushSettingsSaves();
    await vi.runAllTimersAsync();
    await flush;
  });
  expect(f.writes).toEqual([['a', 4]]);
});
