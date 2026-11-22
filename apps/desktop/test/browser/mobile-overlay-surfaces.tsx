import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RedBagQrcodeHost } from '../../src/renderer/src/components/RedBagQrcodeDialog';
import { openRedBagQrcode } from '../../src/renderer/src/components/RedBagQrcodeDialog.shared';
import { GiftMallPanel } from '../../src/renderer/src/components/gift/GiftMallPanel';
import { AlbumExportLightbox } from '../../src/renderer/src/views/export/AlbumExportLightbox';
import { GroupFileExportLightbox } from '../../src/renderer/src/views/export/GroupFileExportLightbox';
import { FailureLightbox } from '../../src/renderer/src/views/export/FailureLightbox';
import { ExportLightbox } from '../../src/renderer/src/views/export/ExportLightbox';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useDialog } from '../../src/renderer/src/components/Dialog.shared';
import { GroupLeftMembersDialog } from '../../src/renderer/src/components/GroupLeftMembersDialog';
import { GroupMemberKickDialog } from '../../src/renderer/src/components/GroupMemberModerationDialogs';
import { MsgElementEditor } from '../../src/renderer/src/components/MsgElementEditor';
import { MsgDressEditor } from '../../src/renderer/src/components/mergeForward/MsgDressEditor';
import { BaselinePicker } from '../../src/renderer/src/views/export/BaselinePicker';
import { attachMobileHistory, mobileBack } from '../../src/renderer/src/hooks/useMobileNavigation';
import { subscribeResponsiveLayout } from '../../src/renderer/src/lib/responsiveLayout';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
subscribeResponsiveLayout(() => {});
const noop = () => {};
const editorElements = [
  {
    kind: 'grayTipPoke',
    elementId: '1234567890123456789',
    grayTipXmlContent: '<gtip align="center">合成消息</gtip>',
    tipJson: JSON.stringify({ text: '合成消息'.repeat(16) }),
    zNestedFields: [{ longUnbrokenFieldName: '最后一个字段' }],
  },
  { kind: 'text', text: '另一个元件' },
];
function Fixture() {
  const [surface, show] = useState('none');
  const [closed, setClosed] = useState(0);
  useEffect(() => attachMobileHistory(), []);
  useEffect(() => {
    if (surface === 'qr')
      openRedBagQrcode({
        qrcodeBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
        lucky: false,
        password: false,
        totalNum: 1,
        totalAmount: 100,
      });
  }, [surface]);
  const close = () => {
    setClosed((value) => value + 1);
    show('none');
  };
  const group = { groupCode: '20001', groupName: '合成群', onConfirm: noop, onClose: close };
  Object.assign(window, {
    mobileOverlayQa: {
      show,
      closed,
      back: mobileBack,
      theme: useThemeStore,
      child: () => {
        void useDialog.getState().confirm('合成确认', '验证一次返回只关闭最上层。');
      },
    },
  });
  return (
    <>
      <style>{'html,body,#root{height:100%;margin:0;overflow:hidden}'}</style>
      <RedBagQrcodeHost />
      <DialogHost />
      {surface === 'editor' && (
        <MsgElementEditor
          msgId="1234567890123456789"
          elements={editorElements}
          onClose={close}
          onSave={async () => {}}
        />
      )}
      {surface === 'kick' && (
        <GroupMemberKickDialog memberName={'Sample'.repeat(60)} onCancel={close} onConfirm={noop} />
      )}
      {surface === 'dress' && (
        <MsgDressEditor decoration={undefined} onClose={close} onChange={noop} />
      )}
      {surface === 'left-members' && (
        <GroupLeftMembersDialog
          groupName="合成群"
          members={Array.from({ length: 12 }, (_, index) => ({
            id: `u_fixture_${index}`,
            displayName: `合成成员 ${index}`,
            identity: `3000${index}`,
          }))}
          loading={false}
          onClose={close}
        />
      )}
      {surface === 'baseline' && <BaselinePicker onClose={close} onSelect={noop} />}
      {surface.startsWith('gift') && (
        <GiftMallPanel peer="u_fixture" peerName="合成用户" onClose={close} />
      )}
      {surface === 'album' && <AlbumExportLightbox {...group} />}
      {surface === 'files' && <GroupFileExportLightbox {...group} />}
      {surface === 'failure' && (
        <FailureLightbox
          taskName="合成任务"
          failures={Array.from({ length: 10 }, (_, index) => ({
            stage: 'image',
            fileName: `sample-${index}.png`,
            error: '合成失败原因',
          }))}
          onClose={close}
        />
      )}
      {surface === 'export' && (
        <ExportLightbox
          variant="contacts"
          headline="导出联系人"
          summary="合成范围"
          onClose={close}
          onConfirm={noop}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
