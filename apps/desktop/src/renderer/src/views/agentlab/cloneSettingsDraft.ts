import { createContext, useContext, useEffect, useRef } from 'react';
import type { client } from '../../trpc/client';
import { useDraftProtection } from '../../lib/draftClose';
import { useSettingsAutosave, type SettingsSection } from '../../hooks/useSettingsAutosave';

type Patch = Omit<Parameters<typeof client.account.updateAgentLabPersona.mutate>[0], 'personaId'>;

export const CloneSettingsDraftContext = createContext<{
  register: (id: string, section: SettingsSection<Patch> | null) => void;
  saving: boolean;
  flush: () => Promise<boolean>;
} | null>(null);

/** 子表单保留草稿，由所属设置窗合并自动保存。 */
export function useCloneSettingsSection(
  id: string,
  value: unknown,
  patch: Patch,
  valid = true,
  busy = false,
) {
  const context = useContext(CloneSettingsDraftContext);
  const guard = useDraftProtection(context ? null : value, context ? false : busy);
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
    });
  }, [register, id, snapshot, patchSnapshot, valid]);
  return { ...guard, managed: !!context, saving: context?.saving ?? false, flush: context?.flush };
}

export function useCloneSettingsDraft(save: (patch: Patch) => Promise<void>) {
  return useSettingsAutosave(save);
}
