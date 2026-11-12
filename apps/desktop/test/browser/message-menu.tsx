import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Star, ListTodo, BrainCircuit, SmilePlus, FolderSearch } from 'lucide-react';
import { MessageMenuButton } from '../../src/renderer/src/components/MessageMenuButton';
import {
  MessageContextMenu,
  type MessageContextMenuState,
} from '../../src/renderer/src/im-template/template/messageContextMenu';
import { HoverTooltip } from '../../src/renderer/src/components/HoverTooltip';
import { ReactionPicker } from '../../src/renderer/src/im-template/template/reactionPicker';
import { createTemplateDemoData } from '../support/templateDemoData';
import { installTouchContextMenu } from '../../src/renderer/src/lib/touchContextMenu';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/component-appearance.css';
import '../../src/renderer/src/styles/retro-appearance.css';
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
      mode?: 'full' | 'sparse' | 'voice' | 'mixed' | 'downloaded' | 'private' | 'record',
    ) => void;
    menuActions: string[];
  }
}
window.menuActions = [];
function Fixture() {
  const [state, setState] = useState<MessageContextMenuState | null>(null);
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState('full');
  const run = (name: string) => () => {
    window.menuActions.push(name);
  };
  const slot = (name: string, icon: React.ReactNode, disabled = false) => (
    <MessageMenuButton
      type="button"
      title={disabled ? `${name}：暂不可用` : name}
      aria-label={name}
      disabled={disabled}
      onClick={run(name)}
    >
      {icon}
      <span>{name}</span>
    </MessageMenuButton>
  );
  window.menuFixture = (x, y, mobile, theme, accent, background, mode = 'full') => {
    const store = useThemeStore.getState();
    store.setPreference(theme);
    store.setAccent(accent);
    store.setBackground(background);
    setMode(mode);
    setState({
      forwardTarget: mode === 'record' ? { elementIndex: 0, resId: 'fixture' } : undefined,
      message:
        mode === 'record'
          ? { ...message, qqElements: [{ type: 'multiMsg', data: { resId: 'fixture' } }] }
          : mode === 'voice' || mode === 'mixed'
            ? {
                ...message,
                qqElements: [
                  ...(mode === 'mixed' ? message.qqElements : []),
                  { type: 'ptt', data: { fileName: 'fixture.amr', fileToken: 'fixture' } },
                ],
              }
            : mode === 'sparse'
              ? { ...message, qqElements: [{ type: 'file', data: { fileName: 'fixture.zip' } }] }
              : message,
      x,
      y,
      variant: mobile ? 'mobile' : 'desktop',
    });
  };
  return (
    <>
      <span hidden data-menu-fixture-mode={mode} />
      <button type="button" id="origin">
        消息
      </button>
      {state && (
        <MessageContextMenu
          state={{ ...state, originElement: document.getElementById('origin') }}
          onClose={() => setState(null)}
          onCopy={() => {
            run('复制')();
            setState(null);
          }}
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
          showReactions={mode !== 'private'}
          essenceAction={slot('移除精华', <Star size={17} />)}
          todoAction={slot('设为群待办', <ListTodo size={17} />, true)}
          intentAction={slot('意图感知', <BrainCircuit size={17} />)}
          favoriteEmojiAction={slot('添加到表情', <SmilePlus size={17} />)}
          revealAction={
            mode === 'downloaded' ? slot('在文件夹中显示', <FolderSearch size={17} />) : null
          }
          {...(mode === 'sparse'
            ? {
                onForward: undefined,
                onMultiSelect: undefined,
                onReply: undefined,
                onRepeat: undefined,
                onRecall: undefined,
                onAddToComposition: undefined,
                onExport: undefined,
                onViewDecoration: undefined,
                onEditRaw: undefined,
                onDelete: undefined,
                onSaveMedia: undefined,
                onReact: undefined,
                essenceAction: null,
                todoAction: null,
                intentAction: null,
                favoriteEmojiAction: null,
                revealAction: null,
              }
            : {})}
        />
      )}
      {more && (
        <ReactionPicker
          originElement={document.getElementById('origin')}
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
