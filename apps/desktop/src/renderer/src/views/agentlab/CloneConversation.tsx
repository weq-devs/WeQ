import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Bot,
  FolderOpen,
  Link2,
  MapPin,
  Mic,
  PhoneCall,
  SendHorizontal,
  Smile,
} from 'lucide-react';
import { AiOutlineRedEnvelope } from 'react-icons/ai';
import { ChatHeader } from '../../components/ChatHeader';
import { ChatBackdrop } from '../../components/ChatBackdrop';
import { useChatBackdrop } from '../../hooks/useDressSkin';
import { ComposerResizeHandle } from '../../im-template/template/composer';
import { EmojiPanel } from '../../im-template/template/emojiPanel';
import type { EmojiItem } from '../../im-template/template/emojiPacks';
import { loadLayoutNumber, saveLayoutNumber } from '../../im-template/template/layoutStorage';
import {
  composerHeightStorageKey,
  composerHeightDefault,
  composerHeightMin,
  composerHeightMax,
} from '../../im-template/template/composerLayout';
import '../../styles/clone-conversation.css';

const ComposerHeightContext = createContext<{
  height: number;
  onChange: (height: number) => void;
} | null>(null);

export function CloneConversation({ children }: { children: ReactNode }) {
  const backdrop = useChatBackdrop();
  const [height, setHeight] = useState(() =>
    loadLayoutNumber(
      composerHeightStorageKey,
      composerHeightDefault,
      composerHeightMin,
      composerHeightMax,
    ),
  );
  return (
    <div
      className="chat-pane weq-clone-conversation"
      style={{ '--clone-composer-height': `${height}px` } as CSSProperties}
    >
      <ChatBackdrop {...backdrop} />
      <ComposerHeightContext.Provider
        value={{
          height,
          onChange: (value) => {
            setHeight(value);
            saveLayoutNumber(composerHeightStorageKey, value);
          },
        }}
      >
        {children}
      </ComposerHeightContext.Provider>
    </div>
  );
}

export function CloneConversationHeader({
  name,
  detail,
  actions,
  onBack,
}: {
  name: string;
  detail?: string;
  actions: ReactNode;
  onBack: () => void;
}) {
  return (
    <ChatHeader
      onBack={onBack}
      title={
        <>
          <span className="chat-title-text" title={detail} data-privacy-sensitive>
            {name}
          </span>
          <small className="bot-badge" title="克隆会话" aria-label="克隆会话">
            <Bot size={12} />
          </small>
        </>
      }
      actions={actions}
    />
  );
}

/** 工具栏保留普通聊天的排列；仅文本与文本表情可发送，其余入口明确禁用。 */
export function CloneComposer({
  inputRef,
  value,
  onChange,
  onSend,
  disabled,
  busy,
  tools,
  children,
  group = false,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  tools?: ReactNode;
  children?: ReactNode;
  group?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const layout = useContext(ComposerHeightContext);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !emojiRef.current?.contains(event.target) &&
        !emojiButtonRef.current?.contains(event.target)
      )
        setEmojiOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [emojiOpen]);
  function insertEmoji(item: EmojiItem) {
    if (disabled || busy || !['system', 'unicode'].includes(item.kind)) return;
    const text =
      item.kind === 'system'
        ? `/${item.name.replace(/^[/[【]+|[\]】]+$/g, '')}`
        : item.glyph || item.token;
    const editor = inputRef.current;
    const start = editor?.selectionStart ?? value.length;
    const end = editor?.selectionEnd ?? start;
    onChange(value.slice(0, start) + text + value.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      editor?.focus();
      editor?.setSelectionRange(start + text.length, start + text.length);
    });
  }
  return (
    <div className="composer weq-clone-composer">
      {layout ? (
        <ComposerResizeHandle
          height={layout.height}
          onHeightChange={layout.onChange}
          minHeight={composerHeightMin}
          maxHeight={composerHeightMax}
        />
      ) : null}
      <div className="composer-tools">
        <button
          ref={emojiButtonRef}
          type="button"
          title="表情"
          aria-label="表情"
          aria-expanded={emojiOpen}
          className={emojiOpen ? 'active' : undefined}
          disabled={disabled || busy}
          onClick={() => setEmojiOpen((open) => !open)}
        >
          <Smile size={21} strokeWidth={1.5} />
        </button>
        <button type="button" title="克隆会话不支持发送红包" aria-label="发红包" disabled>
          <AiOutlineRedEnvelope size={21} />
        </button>
        {!group ? (
          <button type="button" title="克隆会话不支持 QQ 通话" aria-label="通话" disabled>
            <PhoneCall size={21} strokeWidth={1.5} />
          </button>
        ) : null}
        <button type="button" title="克隆会话暂不支持发送录音" aria-label="语音" disabled>
          <Mic size={21} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          title="克隆会话暂不支持发送图片或文件"
          aria-label="发送图片或文件"
          disabled
        >
          <FolderOpen size={21} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          title="克隆会话不支持发送 Ark 卡片"
          aria-label="发送 Ark 卡片"
          disabled
        >
          <Link2 size={21} strokeWidth={1.5} />
        </button>
        <button type="button" title="克隆会话不支持实时位置共享" aria-label="位置共享" disabled>
          <MapPin size={21} strokeWidth={1.5} />
        </button>
        {tools}
        {busy ? <span role="status">对方正在输入…</span> : null}
      </div>
      {emojiOpen && !disabled && !busy ? (
        <EmojiPanel panelRef={emojiRef} onSelect={insertEmoji} textOnly />
      ) : null}
      {children}
      <textarea
        ref={inputRef}
        className="composer-editor"
        value={value}
        aria-label="消息"
        placeholder={disabled ? '旧版对话（只读）' : '发送消息'}
        disabled={disabled || busy}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (disabled || busy) return;
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !composing &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <button
        type="button"
        className="composer-send"
        title="发送"
        aria-label="发送消息"
        disabled={disabled || busy || !value.trim()}
        onClick={onSend}
      >
        <SendHorizontal size={17} />
        <strong>发送</strong>
      </button>
    </div>
  );
}
