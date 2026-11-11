import { createRoot } from 'react-dom/client';
import { ChatHome } from '../../src/renderer/src/views/ChatHome';
import '../../src/renderer/src/styles/index.css';

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100dvh', overflow: 'hidden' }}>
    <ChatHome nickname="合成测试昵称" />
  </div>,
);
