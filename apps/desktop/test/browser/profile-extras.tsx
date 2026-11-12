import { createRoot } from 'react-dom/client';
import { ProfileExtras, ProfileLabelAlbum } from '../../src/renderer/src/components/ProfileExtras';
import { qa, trpc, useQQWriteSession } from './profile-extras.stub';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

Object.assign(window, { profileExtrasQa: qa });
useViewState.setState({ openedUin: '10001' });
function LabelFixture() {
  const session = useQQWriteSession();
  const input = { ...session.binding, uin: '10001' };
  const query = trpc.account.profileExtras.personalityLabels.useQuery(input);
  return (
    <div className="weq-profile-tags">
      {query.data?.labels.map((label) => (
        <ProfileLabelAlbum
          key={label.id}
          input={input}
          online={session.available}
          label={label}
          refresh={query.refetch}
        />
      ))}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 18, maxWidth: 700, margin: '0 auto' }}>
    <h1 style={{ fontSize: 18 }}>合成联系人</h1>
    <p data-local-signature>本地签名立即显示，不等待在线资料。</p>
    <ProfileExtras uin="10001" section="signature" />
    <ProfileExtras uin="10001" />
    <LabelFixture />
    <DialogHost />
  </main>,
);
