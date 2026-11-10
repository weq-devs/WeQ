import { useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { installTouchContextMenu } from '../../src/renderer/src/lib/touchContextMenu';
import '../../src/renderer/src/styles/touch-context-menu.css';

installTouchContextMenu(document);
function Fixture() {
  const [menu, setMenu] = useState('');
  const [clicks, setClicks] = useState(0);
  const surface = (name: string) => (
    <button
      key={name}
      type="button"
      data-surface={name}
      onClick={() => setClicks((value) => value + 1)}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(name);
        document.body.dataset.menus = String(Number(document.body.dataset.menus ?? 0) + 1);
      }}
    >
      <span>{name}</span>
    </button>
  );
  return (
    <>
      {['会话', '联系人', '消息', '图片', '空白区域'].map(surface)}
      {createPortal(surface('弹窗内容'), document.body)}
      <textarea aria-label="编辑" />
      <output data-clicks={clicks}>{menu}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
