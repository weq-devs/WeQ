import { useCallback, useEffect, useRef, useState } from 'react';

export type SettingsSection<P> = { snapshot: string; patch: P; valid: boolean };
type Section<P> = SettingsSection<P> & { baseline: string };

/** 保存成功只确认发出时的快照；在途的新输入继续留在下一批。 */
export function useSettingsAutosave<P extends object>(save: (patch: P) => Promise<void>) {
  const sections = useRef(new Map<string, Section<P>>());
  const writer = useRef(save);
  writer.current = save;
  const [revision, update] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const notify = useCallback(() => {
    if (mounted.current) update((value) => value + 1);
  }, []);
  const register = useCallback(
    (id: string, value: SettingsSection<P> | null) => {
      if (!value) return;
      const prior = sections.current.get(id);
      if (
        prior?.snapshot === value.snapshot &&
        prior.valid === value.valid &&
        JSON.stringify(prior.patch) === JSON.stringify(value.patch)
      )
        return;
      sections.current.set(id, { ...value, baseline: prior?.baseline ?? value.snapshot });
      setError('');
      notify();
    },
    [notify],
  );
  const flush = useCallback((): Promise<boolean> => {
    if (active.current) return active.current;
    const run = async () => {
      setSaving(true);
      setError('');
      try {
        for (;;) {
          if (!mounted.current) return false;
          const changed = [...sections.current].filter(
            ([, value]) => value.snapshot !== value.baseline,
          );
          const valid = changed.filter(([, value]) => value.valid);
          if (!valid.length) return !changed.length;
          const patch = Object.assign({}, ...valid.map(([, value]) => value.patch)) as P;
          await writer.current(patch);
          for (const [id, sent] of valid) {
            const current = sections.current.get(id);
            if (current) sections.current.set(id, { ...current, baseline: sent.snapshot });
          }
          notify();
        }
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        active.current = null;
        if (mounted.current) setSaving(false);
      }
    };
    active.current = Promise.resolve().then(run);
    return active.current;
  }, [notify]);
  const changed = [...sections.current.values()].filter(
    (value) => value.snapshot !== value.baseline,
  );
  const dirty = changed.length > 0;
  const valid = changed.every((value) => value.valid);
  useEffect(() => {
    if (!dirty || !valid || error) return;
    const timer = setTimeout(() => void flush(), 500);
    return () => clearTimeout(timer);
  }, [revision, dirty, valid, error, flush]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    register,
    flush,
    saving,
    dirty,
    valid,
    error,
    status: error ? '保存失败' : saving ? '保存中…' : dirty ? '未保存' : '已保存',
  };
}
