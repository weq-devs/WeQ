import { createRoot } from 'react-dom/client';
import { ProfileExtras } from '../../src/renderer/src/components/ProfileExtras';
import { qa } from './profile-extras.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

Object.assign(window, { profileExtrasQa: qa });
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 18, maxWidth: 700, margin: '0 auto' }}>
    <h1 style={{ fontSize: 18 }}>合成联系人</h1>
    <p data-local-signature>本地签名立即显示，不等待在线资料。</p>
    <ProfileExtras uin="10001" section="signature" />
    <ProfileExtras uin="10001" />
  </main>,
);
