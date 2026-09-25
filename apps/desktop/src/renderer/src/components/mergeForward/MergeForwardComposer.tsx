/**
 * MergeForwardComposer —— 合并转发的**核心编辑组件**（SnowLuma 式分段编辑器）。
 *
 * 一份「合成聊天记录」= 一串预览消息（{@link MfNode}）。合并转发的惯例是
 * **无论谁发的都显示在左侧**，所以这里每条消息都是左对齐的「头像 + 昵称 + 气泡」，
 * 与我们自己在不在这个会话无关。
 *
 * 交互：
 *   - 列表行之间悬停出现「＋ 插入消息」，可在任意位置插入（不只是末尾）；
 *   - 点一行 / 右键 → 展开**分段编辑器**：逐段增删改排序，能拼出所有可发元素；
 *   - 空消息的「添加段」菜单里单独一颗「插入聊天记录」→ 这张卡片就是这条消息的
 *     全部内容（记录独占一条消息，插入后就没有「添加段」了），点「编辑」进去是
 *     一份**消息列表**：能加消息、改发送人、上下移、逐条编辑，消息内容里还能
 *     再套一张（最多 4 层）；
 *   - 逐条消息的装扮（40801）会原样渲染并**保留**，接线发送时用得上。
 *
 * 能加的段是**收窄**过的（见 {@link allowedKinds}）：空消息任选一种起头；已有
 * 内容的消息只能再补 文本 / @ / 表情 / 引用 / 图片（引用至多一处）。
 *
 * 组件只负责编辑；标题、草稿持久化、进入下一步「选择会话」由外层的对话框负责。
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Code2,
  FileText,
  Film,
  Forward,
  Image as ImageIcon,
  Layers,
  Mic,
  Pencil,
  Plus,
  Quote,
  Search,
  Smile,
  Sparkles,
  Sticker,
  Trash2,
  Type,
  UserCog,
  UserPlus,
  X,
} from 'lucide-react';
import { QqMessageContent } from '../QqMessageContent';
import { FaceEmoji } from '../FaceEmoji';
import { FacePicker } from '../compose/FacePicker';
import { QqAvatar } from '../QqAvatar';
import { useToast } from '../Toast';
import { useMsgDecoration } from '../../hooks/useMsgDecoration';
import { useActiveWidget } from '../../hooks/useActiveWidget';
import { useBubbleFontFx } from '../../hooks/useBubbleFontFx';
import { useOverlayLayer } from '../../lib/overlayStack';
import { localFileUrl } from '../../lib/resourceUrl';
import { trpc } from '../../trpc/client';
import { cn } from '../../im-template/template/classNames';
import { dedupePersons, SenderPicker, type MfPerson } from './SenderPicker';
import {
  blankNestedRecordSeg,
  blankSeg,
  createNode,
  draftTitle,
  isNestedContent,
  segHasContent,
  segLabel,
  segsToRenderElements,
  type MfDraft,
  type MfNode,
  type MfSeg,
  type MfSegKind,
  type MfSender,
} from './model';

// 分段在编辑态下的元信息（菜单图标 / 标签 / 分类）。
const SEG_META: Record<MfSegKind, { label: string; icon: ReactElement }> = {
  text: { label: '文本', icon: <Type size={15} /> },
  at: { label: '@某人', icon: <span className="weq-mf-at">@</span> },
  reply: { label: '引用', icon: <Quote size={15} /> },
  face: { label: '表情', icon: <Smile size={15} /> },
  image: { label: '图片', icon: <ImageIcon size={15} /> },
  record: { label: '语音', icon: <Mic size={15} /> },
  video: { label: '视频', icon: <Film size={15} /> },
  file: { label: '文件', icon: <FileText size={15} /> },
  mface: { label: '商城表情', icon: <Sticker size={15} /> },
  ark: { label: 'JSON 卡片', icon: <Code2 size={15} /> },
  xml: { label: 'XML 卡片', icon: <Code2 size={15} /> },
  markdown: { label: 'Markdown', icon: <Code2 size={15} /> },
  emojiBounce: { label: '表情弹射', icon: <Sparkles size={15} /> },
  card: { label: '转发卡片', icon: <Forward size={15} /> },
  node: { label: '聊天记录', icon: <Layers size={15} /> },
};

const SEG_ORDER: MfSegKind[] = [
  'text',
  'at',
  'reply',
  'face',
  'image',
  'record',
  'video',
  'file',
  'mface',
  'ark',
  'xml',
  'markdown',
  'emojiBounce',
  'card',
  'node',
];

/**
 * 一条消息里能**叠加**的段：真实 QQ 消息能共存的就这几类。
 *
 * 其余（语音 / 视频 / 文件 / 商城表情 / 各类卡片 / 聊天记录）都是一次性的重磅元素，
 * 只能作为这条消息的**第一段**出现，不能再往已有内容上补。
 */
const STACKABLE_KINDS: MfSegKind[] = ['text', 'at', 'reply', 'face', 'image'];

function personToSender(p: MfPerson): MfSender {
  return { uid: p.uid, uin: p.uin, name: p.name };
}

/**
 * 一个内容区当前允许加入哪些分段：
 *   - 空内容：任选一种起头（`allowRecord` 时含「插入聊天记录」）；
 *   - 已有内容：只能补 text / at / 引用 / 表情 / 图片，且**引用至多一处**；
 *   - 内容是一份聊天记录：记录独占一条消息，什么都不能再加（调用方会藏起添加按钮）。
 */
function allowedKinds(segs: MfSeg[], allowRecord: boolean): MfSegKind[] {
  const usable = segs.filter(segHasContent);
  if (usable.length === 0) {
    return allowRecord ? SEG_ORDER : SEG_ORDER.filter((kind) => kind !== 'node');
  }
  if (usable.some((seg) => seg.t === 'node')) return [];
  const hasReply = usable.some((seg) => seg.t === 'reply');
  return STACKABLE_KINDS.filter((kind) => kind !== 'reply' || !hasReply);
}

interface EditorState {
  /** null = 新增；否则是被编辑节点的 id。 */
  nodeId: string | null;
  /** 插入位置（0..nodes.length）；编辑已有节点时等于它的下标。 */
  at: number;
  segs: MfSeg[];
  sender: MfSender;
}

export function MergeForwardComposer({
  draft,
  onChange,
  self,
  members,
  senderMode,
}: {
  draft: MfDraft;
  onChange: (draft: MfDraft) => void;
  /** 自己 —— 会话成员里也要能选自己。 */
  self: MfPerson;
  /** 会话模式下的候选人（会话成员）。 */
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
}): ReactElement {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pickerFor, setPickerFor] = useState<
    { kind: 'editor' } | { kind: 'node'; id: string } | null
  >(null);
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodes = draft.nodes;

  function commit(nextNodes: MfNode[]): void {
    onChange({ ...draft, nodes: nextNodes, updatedAt: Math.floor(Date.now() / 1000) });
  }

  function startInsert(at: number): void {
    setError(null);
    setEditor({
      nodeId: null,
      at,
      segs: [],
      sender: nodes[at - 1]?.sender ?? nodes[nodes.length - 1]?.sender ?? personToSender(self),
    });
    setMenu(null);
  }

  function startEdit(node: MfNode, index: number): void {
    setError(null);
    setEditor({ nodeId: node.id, at: index, segs: node.segs, sender: node.sender });
    setMenu(null);
  }

  function saveEditor(): void {
    if (!editor) return;
    if (!editor.segs.some(segHasContent)) {
      setError('至少写一点内容');
      return;
    }
    if (editor.nodeId) {
      commit(
        nodes.map((n) =>
          n.id === editor.nodeId ? { ...n, sender: editor.sender, segs: editor.segs } : n,
        ),
      );
    } else {
      const node = createNode(editor.sender, editor.segs);
      const next = [...nodes];
      next.splice(Math.min(Math.max(editor.at, 0), next.length), 0, node);
      commit(next);
    }
    setEditor(null);
    setError(null);
  }

  function removeNode(id: string): void {
    commit(nodes.filter((n) => n.id !== id));
    setMenu(null);
  }

  function changeSender(nodeId: string, person: MfPerson): void {
    commit(nodes.map((n) => (n.id === nodeId ? { ...n, sender: personToSender(person) } : n)));
    setPickerFor(null);
  }

  if (pickerFor) {
    return (
      <SenderPicker
        mode={senderMode}
        members={members}
        self={self}
        onBack={() => setPickerFor(null)}
        onPick={(person) => {
          if (pickerFor.kind === 'editor') {
            setEditor((cur) => (cur ? { ...cur, sender: personToSender(person) } : cur));
            setPickerFor(null);
          } else {
            changeSender(pickerFor.id, person);
          }
        }}
      />
    );
  }

  return (
    <div className="weq-mf-composer">
      <div className="weq-mf-preview">
        {nodes.length === 0 && !editor ? (
          <div className="weq-mf-preview-empty">
            <ImageIcon size={26} strokeWidth={1.5} />
            <span>还没有消息，点下面「插入消息」拼一条。</span>
          </div>
        ) : null}

        {nodes.map((node, index) => (
          <div key={node.id} className="weq-mf-slot">
            {!editor && index === 0 ? <InsertButton onClick={() => startInsert(0)} /> : null}

            {editor && editor.nodeId === node.id ? (
              <NodeEditor
                segs={editor.segs}
                onChange={(segs) => setEditor((cur) => (cur ? { ...cur, segs } : cur))}
                sender={editor.sender}
                onPickSender={() => setPickerFor({ kind: 'editor' })}
                onSave={saveEditor}
                onCancel={() => {
                  setEditor(null);
                  setError(null);
                }}
                error={error}
                self={self}
                members={members}
                senderMode={senderMode}
                depth={0}
              />
            ) : (
              <PreviewRow
                node={node}
                onOpen={() => startEdit(node, index)}
                onAvatar={() => setPickerFor({ kind: 'node', id: node.id })}
                onContextMenu={(x, y) => setMenu({ nodeId: node.id, x, y })}
              />
            )}

            {!editor || editor.nodeId !== null || editor.at !== index + 1 ? (
              <InsertButton onClick={() => startInsert(index + 1)} />
            ) : null}
          </div>
        ))}

        {editor && editor.nodeId === null && editor.at >= nodes.length ? (
          <NodeEditor
            segs={editor.segs}
            onChange={(segs) => setEditor((cur) => (cur ? { ...cur, segs } : cur))}
            sender={editor.sender}
            onPickSender={() => setPickerFor({ kind: 'editor' })}
            onSave={saveEditor}
            onCancel={() => {
              setEditor(null);
              setError(null);
            }}
            error={error}
            self={self}
            members={members}
            senderMode={senderMode}
            depth={0}
          />
        ) : null}

        {!editor ? (
          <button type="button" className="weq-mf-add" onClick={() => startInsert(nodes.length)}>
            <Plus size={15} />
            插入消息
          </button>
        ) : null}
      </div>

      {menu ? (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onEdit={() => {
            const index = nodes.findIndex((n) => n.id === menu.nodeId);
            const node = nodes[index];
            if (node) startEdit(node, index);
          }}
          onInsertAfter={() => {
            const index = nodes.findIndex((n) => n.id === menu.nodeId);
            startInsert(index + 1);
          }}
          onChangeSender={() => {
            setPickerFor({ kind: 'node', id: menu.nodeId });
            setMenu(null);
          }}
          onDelete={() => removeNode(menu.nodeId)}
        />
      ) : null}
    </div>
  );
}

function InsertButton({ onClick }: { onClick: () => void }): ReactElement {
  return (
    <button type="button" className="weq-mf-insert" onClick={onClick} title="在这里插入一条消息">
      <Plus size={13} />
      <span>插入消息</span>
    </button>
  );
}

/** 一行预览消息：头像 + 昵称 + 时间 + 气泡（带装扮）。 */
function PreviewRow({
  node,
  onOpen,
  onAvatar,
  onContextMenu,
}: {
  node: MfNode;
  onOpen: () => void;
  onAvatar: () => void;
  onContextMenu: (x: number, y: number) => void;
}): ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const msgDec = useMsgDecoration(node.decoration);
  const { widget: activeWidget, scope: activeScope } = useActiveWidget();
  const fontFxAttr = useBubbleFontFx(msgDec.fontFx, rowRef);
  const widget = msgDec.widget ?? (activeScope === 'all' ? activeWidget : null);
  const name = node.sender?.name || node.sender?.uin || '未知用户';
  return (
    <div
      ref={rowRef}
      className="weq-forward-row weq-mf-row"
      data-bubble={msgDec.bubbleId || undefined}
      data-font={msgDec.fontId || undefined}
      data-fontfx={fontFxAttr}
      data-widget={widget?.animated ? widget.itemId : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        className="weq-forward-avatar weq-mf-avatar"
        title="点击 / 右键修改发送人"
        onClick={onAvatar}
        onContextMenu={(event) => {
          event.preventDefault();
          onAvatar();
        }}
      >
        <QqAvatar uin={node.sender?.uin} size={40} className="weq-mf-avatar-img" />
      </button>
      <div className="weq-forward-row-main weq-mf-row-main">
        <div className="weq-forward-row-meta weq-mf-row-meta">
          <span className="weq-forward-row-name weq-mf-row-name">{name}</span>
          <span className="weq-forward-row-time weq-mf-row-time">{formatNodeTime(node.time)}</span>
          <button type="button" className="weq-mf-row-edit" onClick={onOpen}>
            <Pencil size={12} /> 编辑
          </button>
        </div>
        <div className="weq-forward-bubble weq-mf-bubble qq-bubble-shell">
          <NodeBubble node={node} />
        </div>
      </div>
    </div>
  );
}

/**
 * 一段内容的气泡：普通内容走 QqMessageContent（和真聊天里长一个样），
 * 内容本身就是一份聊天记录时画成聊天记录卡片。
 */
function SegBubble({
  segs,
  time,
  msgId,
}: {
  segs: MfSeg[];
  time: number;
  msgId?: string;
}): ReactElement {
  if (isNestedContent(segs)) return <NestedCard segs={segs} />;
  return (
    <QqMessageContent
      elements={segsToRenderElements(segs) as never}
      sendTimeMs={(time || 0) * 1000}
      msgId={msgId ?? ''}
    />
  );
}

/** 一条消息的内容气泡（外层消息列表用）。 */
function NodeBubble({ node }: { node: MfNode }): ReactElement {
  return <SegBubble segs={node.segs} time={node.time} msgId={node.sourceMsgId ?? node.id} />;
}

/** 一份「聊天记录」分段里的子节点（外面那层只为了类型收窄）。 */
type MfRecordNode = Extract<MfSeg, { t: 'node' }>;

function recordNodes(segs: MfSeg[]): MfRecordNode[] {
  return segs.filter((seg): seg is MfRecordNode => seg.t === 'node');
}

/** 卡片标题（QQ 同款「A和B的聊天记录」）。 */
function recordCardTitle(nodes: MfRecordNode[]): string {
  return draftTitle(
    nodes.map((n) => ({
      id: n.id,
      sender: { uid: '', uin: n.userUin, name: n.nickname },
      segs: n.segs,
      time: n.time,
    })),
  );
}

/** 聊天记录卡片（纯展示：标题 + 前几行预览 + 条数，可选一颗操作按钮）。 */
function NestedCard({ segs, action }: { segs: MfSeg[]; action?: ReactElement }): ReactElement {
  const nodes = recordNodes(segs).filter(segHasContent);
  const lines = nodes.slice(0, 4).map((n) => ({
    key: n.id,
    name: n.nickname || n.userUin || 'QQ用户',
    text: n.segs.map(segLabel).join('').trim(),
  }));
  return (
    <div className="weq-mf-nested-card">
      <div className="weq-mf-nested-title">{recordCardTitle(nodes)}</div>
      <div className="weq-mf-nested-lines">
        {lines.length === 0 ? (
          <div className="weq-mf-nested-line">
            <span className="weq-mf-nested-line-text weq-mf-nested-line-empty">
              还没有内容，点「填写内容」
            </span>
          </div>
        ) : null}
        {lines.map((line) => (
          <div key={line.key} className="weq-mf-nested-line">
            <span className="weq-mf-nested-line-name">{line.name}:</span>
            <span className="weq-mf-nested-line-text">{line.text}</span>
          </div>
        ))}
      </div>
      <div className="weq-mf-nested-foot">
        <Layers size={13} /> {nodes.length} 条消息
        {action ? <span className="weq-mf-nested-foot-action">{action}</span> : null}
      </div>
    </div>
  );
}

function formatNodeTime(seconds: number): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ───────────────────────────── 分段编辑器 ─────────────────────────────

/**
 * NodeEditor —— 一个节点的内容编辑器（也是嵌套转发节点的编辑器，靠 `depth` 递归）。
 * `segs` 里出现 `node` 段时，那个段自身又是一个 NodeEditor。
 */
function NodeEditor({
  segs,
  onChange,
  sender,
  onPickSender,
  onSave,
  onCancel,
  error,
  self,
  members,
  senderMode,
  depth,
  embedded = false,
  recordAllowed = true,
}: {
  segs: MfSeg[];
  onChange: (segs: MfSeg[]) => void;
  sender: MfSender;
  onPickSender: () => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
  self: MfPerson;
  members?: MfPerson[];
  /** 嵌套记录里「修改发送人」复用同一个选择器（会话成员 / 全局搜索）。 */
  senderMode: 'conversation' | 'global';
  depth: number;
  /** 嵌在「聊天记录」卡片里时，底部不再重复放「保存 / 取消」，退出由卡片头部负责。 */
  embedded?: boolean;
  /** 这条消息的内容还能不能放一份聊天记录（嵌套层数上限）。 */
  recordAllowed?: boolean;
}): ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const kinds = allowedKinds(segs, recordAllowed);
  const record = isNestedContent(segs);

  const patch = (id: string, next: MfSeg) => onChange(segs.map((s) => (s.id === id ? next : s)));
  const remove = (id: string) => onChange(segs.filter((s) => s.id !== id));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= segs.length || from === to) return;
    const next = segs.slice();
    const [it] = next.splice(from, 1);
    if (!it) return;
    next.splice(to, 0, it);
    onChange(next);
  };

  // 内容是「聊天记录」时，整条消息交给记录编辑器 —— 记录独占一条消息，
  // 所以这里没有「添加段」，也不会有普通分段。
  if (record) {
    return (
      <div className={cn('weq-mf-inline-editor', embedded && 'weq-mf-inline-editor-embedded')}>
        {embedded ? null : (
          <div className="weq-mf-inline-head">
            <button
              type="button"
              className="weq-mf-sender-chip"
              onClick={onPickSender}
              title="修改发送人"
            >
              <QqAvatar uin={sender.uin} size={26} />
              <span>{sender.name || sender.uin || '未命名'}</span>
            </button>
            <span className="weq-mf-mode-tag">这条消息的内容是一份聊天记录</span>
          </div>
        )}

        <RecordContent
          segs={segs}
          onChange={onChange}
          self={self}
          members={members}
          senderMode={senderMode}
          depth={depth}
          nestedAllowed={recordAllowed && depth < 4}
        />

        {embedded ? null : (
          <div className="weq-mf-inline-tools">
            <span className="weq-mf-inline-spacer" />
            <button type="button" className="weq-mf-soft" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="weq-mf-primary" onClick={onSave}>
              保存
            </button>
          </div>
        )}

        {error ? <div className="weq-mf-error">{error}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'weq-mf-inline-editor',
        depth > 0 && 'weq-mf-inline-editor-nested',
        embedded && 'weq-mf-inline-editor-embedded',
      )}
    >
      <div className="weq-mf-inline-head">
        <button
          type="button"
          className="weq-mf-sender-chip"
          onClick={onPickSender}
          title="修改发送人"
        >
          <QqAvatar uin={sender.uin} size={26} />
          <span>{sender.name || sender.uin || '未命名'}</span>
        </button>
        <span className="weq-mf-inline-hint">逐段拼内容；Ctrl/⌘ + 回车保存</span>
      </div>

      <div
        className="weq-mf-seg-list"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSave();
          }
        }}
      >
        {segs.length === 0 ? (
          <div className="weq-mf-seg-empty">空消息 —— 点下面「添加段」开始拼</div>
        ) : null}

        {segs.map((seg, index) => (
          <SegRow
            key={seg.id}
            seg={seg}
            index={index}
            count={segs.length}
            onChange={(next) => patch(seg.id, next)}
            onRemove={() => remove(seg.id)}
            onMove={(to) => move(index, to)}
            self={self}
            members={members}
            senderMode={senderMode}
            depth={depth}
          />
        ))}
      </div>

      <div className="weq-mf-inline-tools">
        <div className="weq-mf-add-wrap">
          {kinds.length > 0 ? (
            <>
              <button
                ref={addBtnRef}
                type="button"
                className="weq-mf-tool"
                onClick={() => setAddOpen((v) => !v)}
                title="给这条消息添加一段内容"
              >
                <Plus size={14} /> 添加段
              </button>
              {addOpen ? (
                <AddSegMenu
                  anchor={addBtnRef.current}
                  kinds={kinds}
                  onPick={(k) => {
                    onChange(
                      k === 'node'
                        ? [blankNestedRecordSeg({ uin: sender.uin, name: sender.name })]
                        : [...segs, blankSeg(k)],
                    );
                    setAddOpen(false);
                  }}
                  onClose={() => setAddOpen(false)}
                />
              ) : null}
            </>
          ) : (
            <span className="weq-mf-note">这条消息已经写满了，不能再加段</span>
          )}
        </div>
        <span className="weq-mf-inline-spacer" />
        {embedded ? null : (
          <>
            <button type="button" className="weq-mf-soft" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="weq-mf-primary" onClick={onSave}>
              保存
            </button>
          </>
        )}
      </div>

      {error ? <div className="weq-mf-error">{error}</div> : null}
    </div>
  );
}

/** 一行分段：类型标签 + 上移/下移/删除 + 该段的编辑器。 */
function SegRow({
  seg,
  index,
  count,
  onChange,
  onRemove,
  onMove,
  self,
  members,
  senderMode,
  depth,
}: {
  seg: MfSeg;
  index: number;
  count: number;
  onChange: (seg: MfSeg) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  depth: number;
}): ReactElement {
  return (
    <div className="weq-mf-seg">
      <div className="weq-mf-seg-head">
        <span className="weq-mf-seg-kind">
          {SEG_META[seg.t].icon}
          {SEG_META[seg.t].label}
        </span>
        <div className="weq-mf-seg-actions">
          <button
            type="button"
            onClick={() => onMove(index - 1)}
            disabled={index === 0}
            title="上移"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(index + 1)}
            disabled={index === count - 1}
            title="下移"
          >
            ↓
          </button>
          <button type="button" className="danger" onClick={onRemove} title="删除">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <SegEditor
        seg={seg}
        onChange={onChange}
        self={self}
        members={members}
        senderMode={senderMode}
        depth={depth}
      />
    </div>
  );
}

/**
 * 「添加段」菜单。**portal 到 body**（不再受对话框 overflow 裁切），位置贴着按钮：
 * 上方放得下就向上弹，放不下就翻到下方，宽高都往视口内夹。
 *
 * 普通段用图标网格；「插入聊天记录」单独一行 —— 它是这版里唯一进入嵌套转发的入口。
 */
function AddSegMenu({
  anchor,
  kinds,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  kinds: MfSegKind[];
  onPick: (kind: MfSegKind) => void;
  onClose: () => void;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 对话框自己占的是 useOverlayLayer 发的层（≥1200），CSS 里的 61 会被它压住。
  const layer = useOverlayLayer(true);
  const gridKinds = kinds.filter((kind) => kind !== 'node');
  const canRecord = kinds.includes('node');

  // portal 到 body 后不再有挂在菜单下面的遮罩，改成文档级监听关闭。
  useEffect(() => {
    function onDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (anchor?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const margin = 8;
    const gap = 8;
    const rect = anchor?.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let top = rect ? rect.top - height - gap : margin;
    if (top < margin) top = rect ? rect.bottom + gap : margin;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - height - margin);
    }
    let left = rect ? rect.left : margin;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    setPos({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={menuRef}
      className="weq-mf-add-menu"
      role="menu"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        zIndex: layer,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {gridKinds.length === 0 && !canRecord ? (
        <div className="weq-mf-empty">这种内容不能再加别的元素</div>
      ) : null}

      {gridKinds.length > 0 ? (
        <div className="weq-mf-add-grid">
          {gridKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="weq-mf-add-item"
              onClick={() => onPick(kind)}
            >
              {SEG_META[kind].icon}
              <span>{SEG_META[kind].label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {canRecord ? (
        <>
          {gridKinds.length > 0 ? <div className="weq-mf-add-sep" /> : null}
          <button type="button" className="weq-mf-add-record" onClick={() => onPick('node')}>
            <Layers size={18} />
            <span className="weq-mf-add-record-text">
              <b>插入聊天记录</b>
              <em>把一份完整的聊天记录放进这条消息里</em>
            </span>
            <Plus size={14} />
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

// 需要时按 kind 打开系统文件框。
function usePickFile(): {
  pick: (
    kind: 'image' | 'record' | 'video' | 'file',
  ) => Promise<{ path: string; fileName: string; size: number } | null>;
} {
  const mut = trpc.account.pickSendFile.useMutation();
  return {
    pick: async (kind) => {
      const res = await mut.mutateAsync({ kind });
      return res ?? null;
    },
  };
}

/**
 * 一份「聊天记录」的内容编辑器 —— 折叠 / 展开两态：
 *   - 折叠：一张和预览完全一致的聊天记录卡片 + 「编辑」（图形化，一眼看懂）；
 *   - 展开：一条「编辑聊天记录」工具栏 + 这份记录里的**消息列表**。
 *
 * 关键语义：记录里的一条**消息** = 一个 `node` 段（对齐协议 `ForwardNode`），
 * 所以「添加消息」是往记录里补一个节点，而不是补一段内容；一条消息的内容里
 * 还能再放一份聊天记录（递归，最多 4 层）。
 */
function RecordContent({
  segs,
  onChange,
  self,
  members,
  senderMode,
  depth,
  nestedAllowed,
}: {
  segs: MfSeg[];
  onChange: (segs: MfSeg[]) => void;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  depth: number;
  /** 还能不能在消息内容里再套一层聊天记录（最多 4 层）。 */
  nestedAllowed: boolean;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const messages = recordNodes(segs);
  const count = messages.filter(segHasContent).length;

  if (!editing) {
    return (
      <div className="weq-mf-record">
        <NestedCard
          segs={segs}
          action={
            <button type="button" className="weq-mf-record-edit" onClick={() => setEditing(true)}>
              <Pencil size={12} /> {count > 0 ? '编辑' : '填写内容'}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="weq-mf-nested weq-mf-nested-editing">
      <div className="weq-mf-nested-bar">
        <Layers size={14} />
        <span className="weq-mf-nested-bar-title">编辑聊天记录</span>
        <span className="weq-mf-nested-bar-count">{count} 条消息</span>
        <button type="button" className="weq-mf-nested-done" onClick={() => setEditing(false)}>
          <Check size={13} /> 完成
        </button>
      </div>
      <RecordMessages
        messages={messages}
        onChange={onChange}
        self={self}
        members={members}
        senderMode={senderMode}
        depth={depth}
        nestedAllowed={nestedAllowed}
      />
    </div>
  );
}

/**
 * 记录里的消息列表：每条消息是「头像 + 昵称 + 时间 + 内容」的一行，可编辑 / 删除 /
 * 上移下移，底部「添加消息」。编辑一行时就地展开这条消息的内容编辑器。
 */
function RecordMessages({
  messages,
  onChange,
  self,
  members,
  senderMode,
  depth,
  nestedAllowed,
}: {
  messages: MfRecordNode[];
  onChange: (next: MfRecordNode[]) => void;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  depth: number;
  nestedAllowed: boolean;
}): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 正在给哪条消息改发送人（非 null 时整块换成 SenderPicker）。 */
  const [pickerId, setPickerId] = useState<string | null>(null);

  function patch(id: string, next: MfRecordNode): void {
    onChange(messages.map((m) => (m.id === id ? next : m)));
  }

  function remove(id: string): void {
    onChange(messages.filter((m) => m.id !== id));
    if (editingId === id) setEditingId(null);
  }

  /** 只在可见行之间上下移（空行不是「消息」，不参与排序）。 */
  function move(id: string, delta: number): void {
    const vis = visibleMessages();
    const vi = vis.findIndex((m) => m.id === id);
    const target = vi + delta;
    if (vi < 0 || target < 0 || target >= vis.length) return;
    const from = messages.findIndex((m) => m.id === id);
    const to = messages.findIndex((m) => m.id === vis[target]!.id);
    if (from < 0 || to < 0) return;
    const next = messages.slice();
    const [it] = next.splice(from, 1);
    if (!it) return;
    next.splice(to, 0, it);
    onChange(next);
  }

  /**
   * 真正渲染成「一条消息」的那些节点：有内容的 + 正在编辑的（哪怕还空着）。
   * 新建记录时占位的那条空消息因此不会直接冒出来（否则就像「自带一条自己发的空消息」）。
   */
  function visibleMessages(): MfRecordNode[] {
    return messages.filter((m) => segHasContent(m) || m.id === editingId);
  }

  function addMessage(): void {
    const last = messages[messages.length - 1];
    const seg = blankNestedRecordSeg({
      uin: last?.userUin || self.uin,
      name: last?.nickname || self.name,
    });
    onChange([...messages, seg]);
    setEditingId(seg.id);
  }

  // 改发送人：复用外层那个可搜索的选择器（会话成员 / 好友 + 群友），而不是手填 QQ 号。
  if (pickerId) {
    return (
      <SenderPicker
        mode={senderMode}
        members={members}
        self={self}
        onBack={() => setPickerId(null)}
        onPick={(person) => {
          const current = messages.find((m) => m.id === pickerId);
          if (current)
            patch(current.id, { ...current, userUin: person.uin, nickname: person.name });
          setPickerId(null);
        }}
      />
    );
  }

  const visible = visibleMessages();

  return (
    <div className="weq-mf-record-list">
      {visible.length === 0 ? (
        <div className="weq-mf-seg-empty">这份聊天记录还没有消息 —— 点下面「添加消息」</div>
      ) : null}

      {visible.map((msg, index) => (
        <div key={msg.id} className="weq-mf-record-item">
          {editingId === msg.id ? (
            <div className="weq-mf-record-editor">
              <div className="weq-mf-inline-head">
                <button
                  type="button"
                  className="weq-mf-sender-chip"
                  onClick={() => setPickerId(msg.id)}
                  title="搜索 / 选择这条消息的发送人"
                >
                  <QqAvatar uin={msg.userUin} size={24} />
                  <span>{msg.nickname || msg.userUin || '未命名'}</span>
                  <Pencil size={11} />
                </button>
                <span className="weq-mf-inline-hint">这条消息的内容</span>
                <button
                  type="button"
                  className="weq-mf-nested-done"
                  onClick={() => setEditingId(null)}
                >
                  <Check size={13} /> 完成
                </button>
              </div>

              <NodeEditor
                segs={msg.segs}
                onChange={(next) => patch(msg.id, { ...msg, segs: next })}
                sender={{ uid: '', uin: msg.userUin, name: msg.nickname }}
                onPickSender={() => setPickerId(msg.id)}
                onSave={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
                error={null}
                self={self}
                members={members}
                senderMode={senderMode}
                depth={depth + 1}
                embedded
                recordAllowed={nestedAllowed}
              />
            </div>
          ) : (
            <div className="weq-forward-row weq-mf-record-msg">
              <div className="weq-forward-avatar weq-mf-avatar">
                <QqAvatar uin={msg.userUin} size={34} />
              </div>
              <div className="weq-forward-row-main weq-mf-row-main">
                <div className="weq-forward-row-meta weq-mf-row-meta">
                  <span className="weq-forward-row-name weq-mf-row-name">
                    {msg.nickname || msg.userUin || 'QQ用户'}
                  </span>
                  <span className="weq-forward-row-time weq-mf-row-time">
                    {formatNodeTime(msg.time)}
                  </span>
                  <button
                    type="button"
                    className="weq-mf-row-edit"
                    onClick={() => setEditingId(msg.id)}
                  >
                    <Pencil size={12} /> 编辑
                  </button>
                  <div className="weq-mf-seg-actions">
                    <button
                      type="button"
                      onClick={() => move(msg.id, -1)}
                      disabled={index === 0}
                      title="上移"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(msg.id, 1)}
                      disabled={index === visible.length - 1}
                      title="下移"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => remove(msg.id)}
                      title="删除这条消息"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="weq-forward-bubble weq-mf-bubble qq-bubble-shell">
                  <SegBubble segs={msg.segs} time={msg.time} />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      <button type="button" className="weq-mf-add" onClick={addMessage}>
        <Plus size={15} /> 添加消息
      </button>
    </div>
  );
}

function SegEditor({
  seg,
  onChange,
  self,
  members,
  senderMode,
  depth,
}: {
  seg: MfSeg;
  onChange: (seg: MfSeg) => void;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  depth: number;
}): ReactElement {
  const { pick } = usePickFile();
  const pushToast = useToast((s) => s.push);
  const [busy, setBusy] = useState(false);

  async function chooseFile(
    kind: 'image' | 'record' | 'video' | 'file',
    apply: (picked: { path: string; fileName: string; size: number }) => void,
  ): Promise<void> {
    setBusy(true);
    try {
      const picked = await pick(kind);
      if (picked) apply(picked);
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '选择文件失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  switch (seg.t) {
    case 'text':
      return (
        <textarea
          className="weq-mf-textarea"
          placeholder="文本内容"
          value={seg.text}
          onChange={(e) => onChange({ ...seg, text: e.target.value })}
        />
      );
    case 'at':
      return (
        <AtEditor
          seg={seg}
          onChange={onChange}
          self={self}
          members={members}
          senderMode={senderMode}
          depth={depth}
        />
      );
    case 'reply':
      return <ReplyEditor seg={seg} onChange={onChange} />;
    case 'face':
      return <FaceEditor seg={seg} onChange={onChange} />;
    case 'image':
      return (
        <MediaField
          label={seg.path ? undefined : '选择一张图片'}
          value={seg.path}
          fileName={seg.fileName}
          kind="image"
          busy={busy}
          onPick={() =>
            void chooseFile('image', (p) =>
              onChange({ ...seg, path: p.path, fileName: p.fileName, size: p.size }),
            )
          }
          onClear={() => onChange({ ...seg, path: '', fileName: undefined })}
        />
      );
    case 'record':
      return (
        <div className="weq-mf-media">
          <MediaField
            value={seg.path}
            fileName={seg.fileName}
            busy={busy}
            label={seg.path ? undefined : '选择语音文件（SILK / 音频）'}
            onPick={() =>
              void chooseFile('record', (p) =>
                onChange({ ...seg, path: p.path, fileName: p.fileName, size: p.size }),
              )
            }
            onClear={() => onChange({ ...seg, path: '', fileName: undefined })}
          />
          <label className="weq-mf-field">
            <span>时长（秒）</span>
            <input
              type="number"
              min={0}
              value={seg.duration ?? ''}
              onChange={(e) =>
                onChange({ ...seg, duration: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
        </div>
      );
    case 'video':
      return (
        <MediaField
          value={seg.path}
          fileName={seg.fileName}
          busy={busy}
          label={seg.path ? undefined : '选择视频文件'}
          onPick={() =>
            void chooseFile('video', (p) =>
              onChange({ ...seg, path: p.path, fileName: p.fileName, size: p.size }),
            )
          }
          onClear={() => onChange({ ...seg, path: '', fileName: undefined })}
        />
      );
    case 'file':
      return (
        <div className="weq-mf-media">
          <MediaField
            value={seg.path}
            fileName={seg.fileName}
            busy={busy}
            label={seg.path ? undefined : '选择文件'}
            onPick={() =>
              void chooseFile('file', (p) =>
                onChange({ ...seg, path: p.path, fileName: p.fileName, size: p.size }),
              )
            }
            onClear={() => onChange({ ...seg, path: '', fileName: undefined })}
          />
          <p className="weq-mf-note">发送时会真实上传这个文件，对方在聊天记录里可以直接下载。</p>
        </div>
      );
    case 'mface':
      return (
        <div className="weq-mf-grid2">
          <input
            className="weq-mf-input mono"
            placeholder="marketEmoticonId（32 位 hex）"
            value={seg.marketEmoticonId}
            onChange={(e) => onChange({ ...seg, marketEmoticonId: e.target.value.trim() })}
          />
          <input
            className="weq-mf-input mono"
            placeholder="emojiPackId"
            value={String(seg.emojiPackId || '')}
            onChange={(e) =>
              onChange({ ...seg, emojiPackId: Number(e.target.value.replace(/\D/g, '')) || 0 })
            }
          />
          <input
            className="weq-mf-input mono"
            placeholder="encryptKey（可选）"
            value={seg.encryptKey ?? ''}
            onChange={(e) => onChange({ ...seg, encryptKey: e.target.value })}
          />
          <input
            className="weq-mf-input"
            placeholder="faceName（可选）"
            value={seg.faceName ?? ''}
            onChange={(e) => onChange({ ...seg, faceName: e.target.value })}
          />
        </div>
      );
    case 'ark':
      return (
        <textarea
          className="weq-mf-textarea mono"
          placeholder='JSON 卡片原文 {"app":…}'
          value={seg.arkData}
          onChange={(e) => onChange({ ...seg, arkData: e.target.value })}
        />
      );
    case 'xml':
      return (
        <textarea
          className="weq-mf-textarea mono"
          placeholder="XML 卡片原文 <msg>…"
          value={seg.xmlContent}
          onChange={(e) => onChange({ ...seg, xmlContent: e.target.value })}
        />
      );
    case 'markdown':
      return (
        <textarea
          className="weq-mf-textarea mono"
          placeholder="Markdown 内容"
          value={seg.content}
          onChange={(e) => onChange({ ...seg, content: e.target.value })}
        />
      );
    case 'emojiBounce':
      return (
        <div className="weq-mf-grid2">
          <input
            className="weq-mf-input mono"
            placeholder="faceId（如 182）"
            value={String(seg.faceId || '')}
            onChange={(e) =>
              onChange({ ...seg, faceId: Number(e.target.value.replace(/\D/g, '')) || 0 })
            }
          />
          <input
            className="weq-mf-input mono"
            placeholder="count（弹射个数）"
            value={seg.count ?? ''}
            onChange={(e) =>
              onChange({ ...seg, count: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <input
            className="weq-mf-input"
            placeholder="表情名（如 笑哭，可选）"
            value={seg.name ?? ''}
            onChange={(e) => onChange({ ...seg, name: e.target.value })}
          />
        </div>
      );
    case 'card':
      return (
        <input
          className="weq-mf-input mono"
          placeholder="已有聊天记录的 resId"
          value={seg.resId}
          onChange={(e) => onChange({ ...seg, resId: e.target.value.trim() })}
        />
      );
    case 'node':
      // 内容是一份聊天记录时，整条消息由 RecordContent 接管，走不到这里。
      return <p className="weq-mf-note">聊天记录是整条消息的内容，不能和其它段混在一条里。</p>;
  }
}

/** 引用（回复）段：指向这条聊天记录里的另一条消息。 */
function ReplyEditor({
  seg,
  onChange,
}: {
  seg: Extract<MfSeg, { t: 'reply' }>;
  onChange: (seg: MfSeg) => void;
}): ReactElement {
  return (
    <div className="weq-mf-reply">
      <div className="weq-mf-grid2">
        <label className="weq-mf-field">
          <span>被引用消息序号</span>
          <input
            className="weq-mf-input mono"
            inputMode="numeric"
            placeholder="如 12345"
            value={seg.origMsgSeq || ''}
            onChange={(e) =>
              onChange({ ...seg, origMsgSeq: Number(e.target.value.replace(/\D/g, '')) || 0 })
            }
          />
        </label>
        <label className="weq-mf-field">
          <span>被引用者 QQ</span>
          <input
            className="weq-mf-input mono"
            inputMode="numeric"
            placeholder="可留空"
            value={seg.origSenderUin ?? ''}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '');
              onChange({ ...seg, origSenderUin: digits ? Number(digits) : undefined });
            }}
          />
        </label>
        <input
          className="weq-mf-input"
          placeholder="显示名（预览用，可留空）"
          value={seg.senderName ?? ''}
          onChange={(e) => onChange({ ...seg, senderName: e.target.value || undefined })}
        />
        <input
          className="weq-mf-input"
          placeholder="引用摘要（预览用，可留空）"
          value={seg.summary ?? ''}
          onChange={(e) => onChange({ ...seg, summary: e.target.value || undefined })}
        />
      </div>
      <p className="weq-mf-note">
        引用只带序号指针，发出去后由客户端自己去找原消息；序号填错对方就点不开。
      </p>
    </div>
  );
}

function AtEditor({
  seg,
  onChange,
  self,
  members,
  senderMode,
  depth,
}: {
  seg: Extract<MfSeg, { t: 'at' }>;
  onChange: (seg: MfSeg) => void;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  depth: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  void depth;
  return (
    <div className="weq-mf-at-editor">
      <button ref={btnRef} type="button" className="weq-mf-soft" onClick={() => setOpen((v) => !v)}>
        {seg.all ? '@全体成员' : seg.name ? `@${seg.name}` : '选择 @ 对象'}
      </button>
      {seg.name && !seg.all ? (
        <button
          type="button"
          className="weq-mf-icon-btn"
          onClick={() => onChange({ ...seg, name: '', uid: '', uin: '', all: false })}
        >
          <X size={14} />
        </button>
      ) : null}
      {open ? (
        <AtPicker
          anchor={btnRef.current}
          self={self}
          members={members}
          senderMode={senderMode}
          onClose={() => setOpen(false)}
          onPick={(person, all) => {
            onChange(
              all
                ? { ...seg, all: true, name: '全体成员', uid: 'all', uin: '0' }
                : { ...seg, all: false, name: person.name, uid: person.uid, uin: person.uin },
            );
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * @ 对象选择：可搜索联系人（会话成员 / 好友 + 群友），也能直接填 uid（或 QQ 号）。
 *
 * 浮层 portal 到 body、z-index 走 {@link useOverlayLayer}，否则会被对话框的层 压住
 * （见 overlayStack：对话框从 1200 起发层，静态 CSS 的 z-index 一律不够）。
 */
function AtPicker({
  anchor,
  self,
  members,
  senderMode,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  self: MfPerson;
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  onPick: (person: MfPerson, all: boolean) => void;
  onClose: () => void;
}): ReactElement {
  const [keyword, setKeyword] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [manualUin, setManualUin] = useState('');
  const [manualName, setManualName] = useState('');
  const needle = keyword.trim();

  // 全局模式：防抖后走统一搜索（好友在前、群友在后），与会话发送人选择器同一份口径。
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    if (senderMode !== 'global') return;
    const timer = window.setTimeout(() => setDebounced(needle), 220);
    return () => window.clearTimeout(timer);
  }, [senderMode, needle]);

  const quick = trpc.account.searchQuick.useQuery(
    { keyword: debounced, limit: 20 },
    { enabled: senderMode === 'global' && debounced.length > 0, staleTime: 30_000 },
  );

  const rows: MfPerson[] = useMemo(() => {
    if (senderMode === 'conversation') {
      const base = dedupePersons([self, ...(members ?? [])]);
      if (!needle) return base;
      const term = needle.toLowerCase();
      return base.filter((p) => p.name.toLowerCase().includes(term) || p.uin.includes(term));
    }
    const friends = dedupePersons(
      (quick.data?.friends ?? []).map((f) => ({
        uid: f.uid,
        uin: f.uin,
        name: f.remark || f.nick || f.uin,
      })),
    );
    const groupMembers = dedupePersons(
      (quick.data?.groupMembers ?? []).map((m) => ({
        uid: m.memberUid,
        uin: m.memberUin,
        name: m.memberDisplay || m.memberUin,
      })),
    );
    return [...friends, ...groupMembers];
  }, [senderMode, self, members, needle, quick.data]);

  const canManual = manualUid.trim().length > 0 || manualUin.trim().length >= 5;

  return (
    <PortaledPopover anchor={anchor} onClose={onClose} className="weq-mf-at-menu">
      <div className="weq-mf-search">
        <Search size={14} />
        <input
          className="weq-mf-search-input"
          placeholder={senderMode === 'global' ? '搜索好友 / 群友（昵称或 QQ 号）' : '搜索会话成员'}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          autoFocus
        />
      </div>

      <div className="weq-mf-at-scroll">
        <button type="button" className="weq-mf-at-item" onClick={() => onPick(self, true)}>
          @全体成员
        </button>
        {senderMode === 'global' && needle && quick.isLoading ? (
          <div className="weq-mf-empty">搜索中…</div>
        ) : rows.length === 0 ? (
          <div className="weq-mf-empty">
            {senderMode === 'global' && !needle ? '输入昵称或 QQ 号开始搜索' : '没有匹配的人'}
          </div>
        ) : (
          rows.map((p) => (
            <button
              key={p.uid || `uin:${p.uin}`}
              type="button"
              className="weq-mf-at-item"
              onClick={() => onPick(p, false)}
            >
              <QqAvatar uin={p.uin} size={22} />
              <span className="weq-mf-person-name">{p.name}</span>
              {p.uin && p.uin !== '0' ? <span className="weq-mf-person-uin">{p.uin}</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="weq-mf-manual">
        {manualOpen ? (
          <div className="weq-mf-manual-form">
            <div className="weq-mf-manual-row">
              <input
                className="weq-mf-input mono"
                placeholder="uid（如 u_xxxx）"
                value={manualUid}
                onChange={(e) => setManualUid(e.target.value.trim())}
              />
            </div>
            <div className="weq-mf-manual-row">
              <input
                className="weq-mf-input mono"
                placeholder="QQ 号（可选）"
                inputMode="numeric"
                value={manualUin}
                onChange={(e) => setManualUin(e.target.value.replace(/\D/g, ''))}
              />
              <input
                className="weq-mf-input"
                placeholder="昵称（可选）"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="weq-mf-primary"
              disabled={!canManual}
              onClick={() =>
                onPick(
                  {
                    uid: manualUid.trim(),
                    uin: manualUin.trim(),
                    name: manualName.trim() || manualUid.trim() || manualUin.trim(),
                  },
                  false,
                )
              }
            >
              使用这个 @ 对象
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="weq-mf-manual-toggle"
            onClick={() => setManualOpen(true)}
          >
            <UserPlus size={15} />
            直接填写 uid / QQ 号
          </button>
        )}
      </div>
    </PortaledPopover>
  );
}

function FaceEditor({
  seg,
  onChange,
}: {
  seg: Extract<MfSeg, { t: 'face' }>;
  onChange: (seg: MfSeg) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="weq-mf-face-editor">
      <button ref={btnRef} type="button" className="weq-mf-soft" onClick={() => setOpen((v) => !v)}>
        {seg.faceId > 0 ? (
          <FaceEmoji element={{ faceId: seg.faceId, faceText: seg.faceText }} size={18} />
        ) : null}
        {seg.faceText || (seg.faceId > 0 ? `表情 ${seg.faceId}` : '选择表情')}
      </button>
      {open ? (
        <PortaledPopover
          anchor={btnRef.current}
          onClose={() => setOpen(false)}
          className="weq-mf-face-pop"
        >
          <FacePicker
            onPick={(f) => {
              onChange({ ...seg, faceId: f.faceId, faceText: f.faceText });
              setOpen(false);
            }}
          />
        </PortaledPopover>
      ) : null}
    </div>
  );
}

/**
 * 一个小浮层：**portal 到 body** + {@link useOverlayLayer} 发层（否则会被对话框压住，
 * 只剩一条几乎看不见的细缝），贴着锚点定位、上下自动翻转、左右往视口内夹；
 * 点浮层外或按 Esc 关闭。@ 候选 / 表情面板共用。
 */
function PortaledPopover({
  anchor,
  onClose,
  className,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  className: string;
  children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const layer = useOverlayLayer(true);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 搜索结果加载完 / 手动表单展开会让浮层变高，重新量一次位置，免得底部越出视口。
  const [sizeTick, setSizeTick] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSizeTick((tick) => tick + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onDown(event: PointerEvent): void {
      const target = event.target as Node;
      // 点锚点按钮时交给它自己的 onClick 切换，不在 pointerdown 里先关一次
      // （否则「关了又立刻开」，按钮看起来切不动）。
      if (anchor?.contains(target) || ref.current?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const gap = 6;
    const rect = anchor?.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let top = rect ? rect.bottom + gap : margin;
    if (rect && top + height > window.innerHeight - margin) {
      const above = rect.top - height - gap;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    let left = rect ? rect.left : margin;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    setPos({ left, top });
  }, [anchor, sizeTick]);

  return createPortal(
    <div
      ref={ref}
      className={className}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        zIndex: layer,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MediaField({
  value,
  fileName,
  busy,
  label,
  kind,
  onPick,
  onClear,
}: {
  value: string;
  fileName?: string;
  busy: boolean;
  label?: string;
  /** 选中的是图片时顺便出个小缩略图（走 weq-media://localfile 读本机文件）。 */
  kind?: 'image' | 'record' | 'video' | 'file';
  onPick: () => void;
  onClear: () => void;
}): ReactElement {
  if (value) {
    return (
      <div className="weq-mf-file-chip">
        {kind === 'image' ? (
          <img className="weq-mf-file-thumb" src={localFileUrl(value)} alt={fileName || ''} />
        ) : (
          <FileText size={14} />
        )}
        <span className="weq-mf-file-name" title={value}>
          {fileName || value}
        </span>
        <button type="button" className="weq-mf-icon-btn" onClick={onClear} title="移除">
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="weq-mf-soft" onClick={onPick} disabled={busy}>
      <Plus size={14} /> {busy ? '选择中…' : (label ?? '选择本机文件')}
    </button>
  );
}

/** 一行消息的右键菜单。 */
function NodeMenu({
  x,
  y,
  onClose,
  onEdit,
  onInsertAfter,
  onChangeSender,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onEdit: () => void;
  onInsertAfter: () => void;
  onChangeSender: () => void;
  onDelete: () => void;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 同上：菜单 portal 到 body，z-index 必须走 useOverlayLayer 才不被对话框压住。
  const layer = useOverlayLayer(true);
  const left = Math.min(x, window.innerWidth - 170);
  const top = Math.min(y, window.innerHeight - 190);

  useEffect(() => {
    function onDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return createPortal(
    <div ref={menuRef} className="weq-mf-menu" style={{ left, top, zIndex: layer }} role="menu">
      <button type="button" role="menuitem" onClick={onEdit}>
        <Pencil size={15} /> 编辑内容
      </button>
      <button type="button" role="menuitem" onClick={onInsertAfter}>
        <Plus size={15} /> 在下方插入
      </button>
      <button type="button" role="menuitem" onClick={onChangeSender}>
        <UserCog size={15} /> 修改发送人
      </button>
      <button type="button" role="menuitem" className="danger" onClick={onDelete}>
        <X size={15} /> 删除这条
      </button>
    </div>,
    document.body,
  );
}

/** 供外层对话框显示默认标题。 */
export function composerDefaultTitle(draft: MfDraft): string {
  return draft.title || draftTitle(draft.nodes);
}
