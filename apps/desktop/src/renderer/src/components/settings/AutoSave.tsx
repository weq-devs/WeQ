import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { SettingsSaveQueue, settingsSaves } from '../../lib/settingsSaveQueue';
import { useDraftProtection } from '../../lib/draftClose';
import { SettingsResetCardContext } from './resetContext';
import { usePageSnapshotKey } from '../PageSnapshots';
import '../../styles/settings-autosave.css';

interface AutoSaveProps<T> {
  value: T;
  saved: T;
  ready?: boolean;
  valid?: boolean;
  save: (value: T) => Promise<void>;
  reset?: () => void;
  resetKeys?: readonly string[];
  children?: ReactNode;
}
export function AutoSave<T>(props: AutoSaveProps<T>) {
  const scope = usePageSnapshotKey('settings-autosave');
  return <AutoSaveField key={scope ?? 'standalone'} {...props} />;
}
function AutoSaveField<T>({
  value,
  saved,
  ready = true,
  valid = true,
  save,
  reset,
  resetKeys,
  children,
}: AutoSaveProps<T>) {
  const [, render] = useState(0);
  const mounted = useRef(true);
  const queue = useRef<SettingsSaveQueue<T> | null>(null);
  if (!queue.current)
    queue.current = new SettingsSaveQueue(saved, () => {
      if (mounted.current) render((n) => n + 1);
    });
  const q = queue.current;
  const latest = useRef({ value, saved, ready, valid, save, reset, resetKeys });
  latest.current = { value, saved, ready, valid, save, reset, resetKeys };
  const composing = useRef(false);
  const card = useContext(SettingsResetCardContext);
  const encoded = JSON.stringify(value);
  const encodedSaved = JSON.stringify(saved);
  const previous = useRef(encoded);
  const first = useRef(true);
  const protection = useDraftProtection(
    ready && (q.dirty || !valid) ? value : null,
    q.status === 'saving',
  );
  if (!ready || (!q.dirty && valid)) protection.reset(null);
  useEffect(() => {
    if (ready) q.observe(saved);
  }, [encodedSaved, ready, saved, q]);
  useEffect(() => {
    if (!ready) {
      q.cancelPending();
      return;
    }
    if (first.current) {
      first.current = false;
      previous.current = encoded;
      if (encoded !== encodedSaved) q.edit(value, valid, save, null);
      return;
    }
    if (previous.current === encoded) return;
    previous.current = encoded;
    if (!composing.current) q.edit(value, valid, save);
  }, [encoded, encodedSaved, ready, value, valid, save, q]);
  useEffect(() => {
    mounted.current = true;
    q.release();
    let rebased = false;
    const entry = {
      get keys() {
        return latest.current.resetKeys;
      },
      flush: () => (q.status === 'error' ? Promise.resolve(false) : q.flush()),
      get pending() {
        return q.status === 'pending' || q.status === 'saving';
      },
      suspend: () => q.suspend(),
      reset: () => {
        rebased = true;
        latest.current.reset?.();
        q.reset(latest.current.saved);
      },
      release: () => {
        q.release();
        const state = latest.current;
        if (!rebased && state.ready) q.edit(state.value, state.valid, state.save, null);
        rebased = false;
      },
    };
    settingsSaves.add(entry);
    card?.add(entry);
    return () => {
      mounted.current = false;
      settingsSaves.delete(entry);
      card?.delete(entry);
      // 正常离页由外层先 flush；卸载不启动未确认的新请求。
      void q.suspend();
    };
  }, [q, card]);
  return (
    <div
      className="weq-autosave"
      onBlurCapture={() => {
        if (!composing.current) void q.flush();
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing &&
          !composing.current &&
          !(event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          void q.flush();
        }
      }}
      onCompositionStart={() => {
        composing.current = true;
        q.cancelPending();
      }}
      onCompositionEnd={() => {
        composing.current = false;
        const state = latest.current;
        if (state.ready) q.edit(state.value, state.valid, state.save);
      }}
    >
      {children}
      <span className="weq-autosave-status" role={q.status === 'error' ? 'alert' : 'status'}>
        {q.status === 'saving'
          ? '正在保存…'
          : q.status === 'saved'
            ? '已保存'
            : q.status === 'error'
              ? `保存失败：${q.error}`
              : !valid && ready
                ? '输入无效，尚未保存'
                : ''}
        {q.status === 'error' ? (
          <button
            type="button"
            className="weq-set-iconbtn"
            title="重试保存"
            aria-label="重试保存"
            onClick={() => void q.flush()}
          >
            <RotateCw size={14} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
