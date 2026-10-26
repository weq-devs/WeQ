import { createRoot } from 'react-dom/client';
import { Camera } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../../src/renderer/src/components/Dialog';
import { useMenuCapture } from '../../src/renderer/src/hooks/useMenuCapture';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-menu.css';
import '../../src/renderer/src/styles/menu-capture.css';

declare global {
  interface Window {
    menuCaptureTest: { calls: number; finish?: () => void };
  }
}

window.menuCaptureTest = { calls: 0 };

function CaptureButton() {
  const controls = useMenuCapture(async () => {
    window.menuCaptureTest.calls++;
    await new Promise<void>((resolve) => {
      window.menuCaptureTest.finish = resolve;
    });
  });
  return (
    <button
      type="button"
      className="weq-workspace-control weq-menu-capture-button"
      aria-label="截图"
      {...controls}
    >
      <Camera size={18} />
    </button>
  );
}

function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <main style={{ padding: 32 }}>
        <h1>合成聊天窗口</h1>
        <p>截图应保留窗口正文，不包含菜单与截图按钮。</p>
        <button type="button" id="open-menu" onClick={() => setOpen(true)}>
          菜单
        </button>
      </main>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        centered
        width={392}
        className="weq-workspace-menu is-compact"
      >
        <header className="weq-workspace-menu-head">
          <h2>合成菜单</h2>
        </header>
        <div className="weq-workspace-menu-body">
          <p>合成任务与助手</p>
        </div>
        <footer className="weq-workspace-controls">
          <CaptureButton />
        </footer>
      </Modal>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
