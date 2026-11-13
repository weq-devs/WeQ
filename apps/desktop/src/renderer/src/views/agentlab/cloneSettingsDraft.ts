import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { client } from '../../trpc/client';
import { useDraftProtection } from '../../lib/draftClose';

type Patch = Omit<Parameters<typeof client.account.updateAgentLabPersona.mutate>[0], 'personaId'>;
type Section = { snapshot: string; patch: Patch; valid: boolean; markSaved: () => void };
type SavedSection = Section & { baseline: string };

export const CloneSettingsDraftContext = createContext<{
  register: (id: string, section: Section | null) => void;
  saving: boolean;
} | null>(null);

/** 子表单保留草稿，所属设置窗一次提交所有已修改配置。 */
export function useCloneSettingsSection(
  id: string,
  value: unknown,
  patch: Patch,
  valid = true,
  busy = false,
) {
  const context = useContext(CloneSettingsDraftContext);
  const guard = useDraftProtection(value, busy || !!context?.saving);
  const snapshot = JSON.stringify(value);
  const patchSnapshot = JSON.stringify(patch);
  const latest = useRef({ patch, markSaved: guard.markSaved });
  latest.current = { patch, markSaved: guard.markSaved };
  const register = context?.register;
  useEffect(() => {
    register?.(id, {
      snapshot,
      patch: latest.current.patch,
      valid,
      markSaved: latest.current.markSaved,
    });
  }, [register, id, snapshot, patchSnapshot, valid]);
  useEffect(() => () => register?.(id, null), [register, id]);
  return { ...guard, managed: !!context, saving: context?.saving ?? false };
}

export function useCloneSettingsDraft() {
  const [sections, setSections] = useState<Record<string, SavedSection>>({});
  const register = useCallback((id: string, section: Section | null) => {
    setSections((current) => {
      const next = { ...current };
      if (section) next[id] = { ...section, baseline: current[id]?.baseline ?? section.snapshot };
      else delete next[id];
      return next;
    });
  }, []);
  const changed = Object.entries(sections).filter(
    ([, section]) => section.snapshot !== section.baseline,
  );
  return {
    register,
    dirty: changed.length > 0,
    valid: changed.every(([, section]) => section.valid),
    patch: changed.reduce<Patch>((patch, [, section]) => Object.assign(patch, section.patch), {}),
    markSaved: () => {
      changed.forEach(([, section]) => {
        section.markSaved();
      });
      setSections((current) => {
        const next = { ...current };
        for (const [id, section] of changed) {
          if (next[id]) next[id] = { ...next[id], baseline: section.snapshot };
        }
        return next;
      });
    },
  };
}
