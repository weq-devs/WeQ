import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Star, ListTodo, BrainCircuit, SmilePlus, FolderSearch } from 'lucide-react';
import {
  MessageContextMenu,
  type MessageContextMenuState,
} from '../../src/renderer/src/im-template/template/messageContextMenu';
import { HoverTooltip } from '../../src/renderer/src/components/HoverTooltip';
import { ReactionPicker } from '../../src/renderer/src/im-template/template/reactionPicker';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import { installTouchContextMenu } from '../../src/renderer/src/lib/touchContextMenu';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles/chat.css';
import '../../src/renderer/src/im-template/styles/screens.css';
import '../../src/renderer/src/im-template/styles/responsive.css';

const message = {
  ...createTemplateDemoData().messages[0]!,
  qqElements: [{ type: 'text', data: { textContent: '**hello**' } }],
  decoration: { bubbleId: 1 },
  setEmojiList: [{ emojiId: '76', setNum: 1, isSelfSet: true }],
};
declare global {
  interface Window {
    menuFixture: (
      x: number,
      y: number,
      mobile: boolean,
      theme: ThemePreference,
      accent: string,
      background: ThemeBackground,
    ) => void;
    menuActions: string[];
  }
}
window.menuActions = [];
function Fixture() {
  const [state, setState] = useState<MessageContextMenuState | null>(null);
  const [more, setMore] = useState(false);
  const run = (name: string) => () => {
    window.menuActions.push(name);
  };
  const slot = (name: string, icon: React.ReactNode, disabled = false) => (
    <button
      type="button"
      title={disabled ? `${name}：暂不可用` : name}
      aria-label={name}
      disabled={disabled}
      onClick={run(name)}
    >
      {icon}
      <span>{name}</span>
    </button>
  );
  window.menuFixture = (x, y, mobile, theme, accent, background) => {
    const store = useThemeStore.getState();
    store.setPreference(theme);
    store.setAccent(accent);
    store.setBackground(background);
    setState({ message, x, y, variant: mobile ? 'mobile' : 'desktop' });
  };
  return (
    <>
      <button type="button" id="origin">
        消息
      </button>
      {state && (
        <MessageContextMenu
          state={{ ...state, originElement: document.getElementById('origin') }}
          onClose={() => setState(null)}
          onCopy={run('复制')}
          onForward={run('转发')}
          onMultiSelect={run('多选')}
          onReply={run('引用')}
          onRepeat={run('+1')}
          onRecall={run('撤回')}
          onAddToComposition={run('添加到素材库')}
          onExport={run('导出')}
          onViewDecoration={run('查看装扮')}
          onEditRaw={run('修改本地记录')}
          onDelete={run('本地删除')}
          onSaveMedia={run('保存')}
          onReact={() => {
            setMore(true);
            setState(null);
          }}
          onSetReaction={(_message, code, isSet) => window.menuActions.push(`${code}:${isSet}`)}
          essenceAction={slot('移除精华', <Star size={17} />)}
          todoAction={slot('设为群待办', <ListTodo size={17} />)}
          intentAction={slot('意图感知', <BrainCircuit size={17} />)}
          favoriteEmojiAction={slot('添加到表情', <SmilePlus size={17} />)}
          revealAction={slot('在文件夹中显示', <FolderSearch size={17} />, true)}
        />
      )}
      {more && (
        <ReactionPicker
          anchor={{ x: 30, y: 30 }}
          selectedCodes={['76']}
          onClose={() => setMore(false)}
          onSelect={(code) => {
            window.menuActions.push(`more:${code}:${code !== '76'}`);
            setMore(false);
          }}
        />
      )}
      <HoverTooltip />
    </>
  );
}
installTouchContextMenu(document);
createRoot(document.getElementById('root')!).render(<Fixture />);
