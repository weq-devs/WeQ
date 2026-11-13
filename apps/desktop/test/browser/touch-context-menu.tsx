import { useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { installTouchContextMenu } from '../../src/renderer/src/lib/touchContextMenu';
import { MessageRow } from '../../src/renderer/src/im-template/template/messageRow';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/touch-context-menu.css';

installTouchContextMenu(document);
const demo = createTemplateDemoData();
const conversation = demo.conversations.find((row) => row.type === 'group')!;
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
      <MessageRow
        user={demo.user}
        conversation={conversation}
        message={{
          ...demo.messages[0]!,
          conversationId: conversation.id,
          body: '长按贴表情回归',
          msgSeq: '42',
          setEmojiList: [{ emojiId: '76', setNum: 1, isSelfSet: false }],
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu('底层消息菜单');
        }}
        onLongPress={() => setMenu('底层消息长按')}
        onReactionChange={() => setClicks((value) => value + 1)}
      />
      <output data-clicks={clicks}>{menu}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
