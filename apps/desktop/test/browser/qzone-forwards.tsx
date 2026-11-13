import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QzoneForwardAction } from '../../src/renderer/src/components/QzoneForwardAction';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/qzone.css';

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') || 'light';
function Scene() {
  const [writes, setWrites] = useState(0);
  const [person, setPerson] = useState('');
  return (
    <main
      className="weq-qzn"
      style={{ padding: 16, maxWidth: 620, margin: '40px auto', color: 'var(--foreground)' }}
    >
      <article className="weq-qzn-post">
        <p>合成动态</p>
        <div className="weq-qzn-actions">
          <QzoneForwardAction
            target={{ selfUin: '10001', hostUin: '10002', tid: 'fixture' }}
            onClick={() => setWrites((value) => value + 1)}
            onSpace={(_uin, nickname) => setPerson(nickname ?? '')}
          />
        </div>
      </article>
      <output aria-label="转发操作次数">{writes}</output>
      <output aria-label="当前用户">{person}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Scene />);
