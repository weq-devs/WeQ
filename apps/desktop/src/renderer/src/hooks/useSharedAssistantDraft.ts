import { useEffect, useRef } from 'react';
import { client } from '../trpc/client';
import {
  accountBinding,
  currentAccountScope,
  useClientPreferences,
  rememberClientRetry,
  forgetClientRetry,
} from '../lib/clientPreferences';
import { resolveDraftSave } from '../lib/draftConflicts';

/** 本机逐字恢复仍由原组件维护；停顿后共享，收到远端变化不覆盖未提交输入。 */
export function useSharedAssistantDraft(
  key: string,
  input: string,
  setInput: (value: string) => void,
  enabled: boolean,
) {
  const live = useRef(input);
  live.current = input;
  const state = useRef({
    key: '',
    version: null as string | null,
    saved: '',
    loaded: false,
    saving: false,
    submitted: null as string | null,
    scope: '',
  });
  const save = useRef<() => Promise<void>>(async () => {});
  save.current = async () => {
    const retry = save.current;
    const binding = accountBinding();
    const current = state.current;
    if (current.scope && current.scope !== currentAccountScope()) {
      useClientPreferences.setState({ error: '请返回原账号后重试草稿保存' });
      return;
    }
    if (
      !enabled ||
      !binding ||
      current.key !== key ||
      !current.loaded ||
      current.saving ||
      live.current === current.saved
    )
      return;
    const value = live.current;
    current.saving = true;
    try {
      const result = await resolveDraftSave(
        key,
        value,
        current.version,
        async (expectedVersion) => {
          const result = await client.clientState.saveDraft.mutate({
            ...binding,
            key,
            value,
            expectedVersion,
          });
          return !result.ok && current.submitted === value ? { ...result, ok: true } : result;
        },
      );
      if (state.current !== current) return;
      forgetClientRetry(`assistant:${current.scope}:${key}`);
      current.version = result.current.version;
      current.saved = typeof result.current.value === 'string' ? result.current.value : '';
      localStorage.setItem(
        `weq.sync.draft-base:${currentAccountScope()}:${key}`,
        JSON.stringify({ version: current.version, saved: current.saved }),
      );
      if (live.current === value && !result.local) setInput(current.saved);
    } catch (error) {
      rememberClientRetry(`assistant:${current.scope}:${key}`, () => {
        if (state.current.key !== key) {
          useClientPreferences.setState({ error: '请回到原草稿后重试保存' });
          return;
        }
        return retry();
      });
      useClientPreferences.setState({ error: `草稿未保存：${String(error)}` });
    } finally {
      current.saving = false;
    }
  };
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = async () => {
      const binding = accountBinding();
      if (!binding) return;
      const remote = await client.clientState.draft.query({ ...binding, key });
      if (!active) return;
      let current = state.current;
      if (current.key !== key) {
        let base: { version: string | null; saved: string } = { version: null, saved: '' };
        try {
          base =
            JSON.parse(
              localStorage.getItem(`weq.sync.draft-base:${currentAccountScope()}:${key}`) ?? 'null',
            ) ?? base;
        } catch {
          /* 旧稿没有版本，保存时进行冲突检查。 */
        }
        current = {
          key,
          ...base,
          loaded: true,
          saving: false,
          submitted: null,
          scope: currentAccountScope(),
        };
        state.current = current;
      }
      if (live.current === current.saved) {
        current.version = remote.version;
        current.saved = typeof remote.value === 'string' ? remote.value : '';
        setInput(current.saved);
      }
    };
    const update = () => void refresh().catch(() => {});
    update();
    window.addEventListener('weq-shared-drafts', update);
    window.addEventListener('weq-shared-account-state', update);
    return () => {
      active = false;
      void save.current();
      window.removeEventListener('weq-shared-drafts', update);
      window.removeEventListener('weq-shared-account-state', update);
    };
  }, [key, enabled, setInput]);
  useEffect(() => {
    const timer = window.setTimeout(() => void save.current(), 900);
    return () => window.clearTimeout(timer);
  }, [input, key]);
  return {
    prepareSubmitted(value: string) {
      const binding = accountBinding();
      const current = state.current;
      return async () => {
        if (!binding) return;
        current.submitted = value;
        const remote = await client.clientState.draft.query({ ...binding, key });
        if (remote.value !== null && remote.value !== value) return;
        await client.clientState.saveDraft.mutate({
          ...binding,
          key,
          value: '',
          expectedVersion: remote.version,
        });
      };
    },
  };
}
