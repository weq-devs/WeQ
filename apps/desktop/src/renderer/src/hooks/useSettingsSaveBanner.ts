import { useEffect } from 'react';
import { useToast } from '../components/Toast.shared';

const key = 'settings-save-progress';
const slowSaves = new Set<symbol>();

export function useSettingsSaveBanner(saving: boolean) {
  useEffect(() => {
    if (!saving) return;
    const save = Symbol();
    const timer = setTimeout(() => {
      const first = slowSaves.size === 0;
      slowSaves.add(save);
      if (first)
        useToast.getState().push({ key, title: '正在保存设置…', loading: true, system: false });
    }, 300);
    return () => {
      clearTimeout(timer);
      if (slowSaves.delete(save) && slowSaves.size === 0) useToast.getState().resolve(key);
    };
  }, [saving]);
}
