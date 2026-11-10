import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSurfaceEscape } from '../../src/renderer/src/lib/surfaceEscape';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/lib/inputModality';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { focusTheme: useThemeStore });

function Dialog({ onClose }: { onClose: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useSurfaceEscape(surface, onClose, true, true);
  return (
    <div ref={surface} role="dialog" aria-modal="true" tabIndex={-1}>
      <button type="button" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

function View() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ padding: 32, display: 'grid', gap: 24 }}>
      <button type="button" className="weq-action-soft" onClick={() => setOpen(true)}>
        打开弹窗
      </button>
      <button type="button" className="weq-action-soft">
        下一个按钮
      </button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<View />);
