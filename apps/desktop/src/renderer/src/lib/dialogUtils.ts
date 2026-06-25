import type { ReactNode } from 'react';
import { useDialog, type DialogTone } from '../components/Dialog';

export interface AppDialogApi {
  info(title: string, message: ReactNode): void;
  error(title: string, message: ReactNode): void;
  confirm(
    title: string,
    message: ReactNode,
    opts?: { okLabel?: string; cancelLabel?: string; tone?: DialogTone },
  ): Promise<boolean>;
}

export function useAppDialog(): AppDialogApi {
  const showInfo = useDialog((s) => s.showInfo);
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);

  return {
    info: showInfo,
    error: showError,
    confirm,
  };
}
