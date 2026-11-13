import { useEffect, useState } from 'react';
import type { WindowControlsStyle } from '../../../shared/window_controls';
import { IS_MAC, IS_WEB } from '../lib/target';

export function useWindowControls(): WindowControlsStyle {
  const [style, setStyle] = useState<WindowControlsStyle>(
    () =>
      (!IS_WEB && window.weq?.windowChrome?.getSnapshot()?.controls) ||
      (IS_MAC ? 'native' : 'windows'),
  );
  useEffect(() => {
    if (IS_WEB) return;
    let active = true;
    const update = (value: unknown) => {
      if (active && (value === 'native' || value === 'windows')) setStyle(value);
    };
    const chrome = window.weq?.windowChrome;
    if (chrome?.getSnapshot()) {
      const off = chrome.onChange((value) => update(value.controls));
      update(chrome.getSnapshot()?.controls);
      return () => {
        active = false;
        off();
      };
    }
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    const off = ipc.on('window:controls-changed', (_event, value: unknown) => update(value));
    void ipc
      .invoke('window:get-controls')
      .then(update)
      .catch(() => undefined);
    return () => {
      active = false;
      off();
    };
  }, []);
  return style;
}
