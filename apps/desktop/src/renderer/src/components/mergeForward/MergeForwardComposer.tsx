/**
 * MergeForwardComposer —— 合并转发的**核心编辑组件**。
 *
 * 一份「合成聊天记录」= 一串预览消息（{@link MfNode}）。合并转发的惯例是
 * **无论谁发的都显示在左侧**，所以这里每条消息都是左对齐的「头像 + 昵称 + 气泡」，
 * 与我们自己在不在这个会话无关。
 *
 * 交互：
 *   - 列表行之间悬停出现「＋ 插入消息」，可在**任意位置**插入（不只是末尾）；
 *   - 右键一行 → 修改内容 / 在下方插入 / 修改发送人 / 删除；
 *   - 右键（或点击）头像 → 修改这条消息的发送人；
 *   - 逐条消息的装扮（40801）会原样渲染并**保留**，接线发送时用得上。
 *
 * 组件只负责编辑；标题、草稿持久化、进入下一步「选择会话」由外层的对话框负责。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Pencil, Plus, Smile, UserCog, X } from 'lucide-react';
import { QqMessageContent } from '../QqMessageContent';
import { FaceEmoji } from '../FaceEmoji';
import { FacePicker } from '../compose/FacePicker';
import { useMsgDecoration } from '../../hooks/useMsgDecoration';
import { useActiveWidget } from '../../hooks/useActiveWidget';
import { useBubbleFontFx } from '../../hooks/useBubbleFontFx';
import type { ResolvedWidget } from '@weq/service';
import { cn } from '../../im-template/template/classNames';
import { SenderPicker, type MfPerson } from './SenderPicker';
import {
  createNode,
  draftTitle,
  mfId,
  senderAvatarUrl,
  type MfDraft,
  type MfElement,
  type MfNode,
  type MfSender,
} from './model';

/** 编辑态的片段：可编辑的文字 / 表情，以及原样保留的富元素（图片、文件…）。 */
type EditSeg =
  | { k: 'text'; id: string; text: string }
  | { k: 'face'; id: string; faceId: number; faceText: string }
  | { k: 'keep'; id: string; el: MfElement };

interface EditorState {
  /** null = 新增；否则是被编辑节点的 id。 */
  nodeId: string | null;
  /** 插入位置（0..nodes.length）；编辑已有节点时等于它的下标。 */
  at: number;
  segs: EditSeg[];
  sender: MfSender;
}

function personToSender(p: MfPerson): MfSender {
  return { uid: p.uid, uin: p.uin, name: p.name };
}

/** 渲染元素 → 编辑片段。非文字 / 表情的元素原样保留，不进文本编辑。 */
function elementsToSegs(elements: MfElement[]): EditSeg[] {
  const segs: EditSeg[] = [];
  for (const el of elements ?? []) {
    if (el?.type === 'text' || el?.type === 'at') {
      const text = typeof el.data?.textContent === 'string' ? el.data.textContent : '';
      if (text) segs.push({ k: 'text', id: mfId('seg'), text });
    } else if (el?.type === 'face') {
      const faceId = Number(el.data?.faceId) || 0;
      const faceText = typeof el.data?.faceText === 'string' ? el.data.faceText : '表情';
      segs.push({ k: 'face', id: mfId('seg'), faceId, faceText });
    } else {
      segs.push({ k: 'keep', id: mfId('seg'), el });
    }
  }
  return segs;
}

/** 编辑片段 → 渲染元素。空文字片段丢弃。 */
function segsToElements(segs: EditSeg[]): MfElement[] {
  const out: MfElement[] = [];
  for (const seg of segs) {
    if (seg.k === 'text') {
      if (seg.text.length === 0) continue;
      out.push({ type: 'text', data: { textContent: seg.text } });
    } else if (seg.k === 'face') {
      out.push({ type: 'face', data: { faceId: seg.faceId, faceText: seg.faceText, subType: 1 } });
    } else {
      out.push(seg.el);
    }
  }
  return out;
}

function hasContent(segs: EditSeg[]): boolean {
  return segs.some((s) => s.k !== 'text' || s.text.trim().length > 0);
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
  const [pickerFor, setPickerFor] = useState<{ kind: 'editor' } | { kind: 'node'; id: string } | null>(
    null,
  );
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [faceOpen, setFaceOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nodes = draft.nodes;

  function commit(nextNodes: MfNode[]): void {
    onChange({ ...draft, nodes: nextNodes, updatedAt: Math.floor(Date.now() / 1000) });
  }

  function startInsert(at: number): void {
    setError(null);
    setFaceOpen(false);
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
    setFaceOpen(false);
    setEditor({ nodeId: node.id, at: index, segs: elementsToSegs(node.elements), sender: node.sender });
    setMenu(null);
  }

  function saveEditor(): void {
    if (!editor) return;
    if (!hasContent(editor.segs)) {
      setError('至少写一点内容（文字或表情）');
      return;
    }
    const node = createNode(editor.sender, segsToElements(editor.segs), undefined);
    if (editor.nodeId) {
      const next = nodes.map((n) =>
        n.id === editor.nodeId
          ? { ...n, sender: editor.sender, elements: node.elements }
          : n,
      );
      commit(next);
    } else {
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

  // 发送人选择器：编辑态改「待发送的人」，node 态改某条已有消息。
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
            {!editor && index === 0 ? (
              <InsertButton onClick={() => startInsert(0)} />
            ) : null}
            {editor && editor.nodeId === null && editor.at === index ? (
              <InlineEditor
                editor={editor}
                setEditor={setEditor}
                onSave={saveEditor}
                onCancel={() => {
                  setEditor(null);
                  setError(null);
                }}
                onPickSender={() => setPickerFor({ kind: 'editor' })}
                faceOpen={faceOpen}
                setFaceOpen={setFaceOpen}
                error={error}
              />
            ) : null}
            {editor && editor.nodeId === node.id ? (
              <InlineEditor
                editor={editor}
                setEditor={setEditor}
                onSave={saveEditor}
                onCancel={() => {
                  setEditor(null);
                  setError(null);
                }}
                onPickSender={() => setPickerFor({ kind: 'editor' })}
                faceOpen={faceOpen}
                setFaceOpen={setFaceOpen}
                error={error}
              />
            ) : (
              <PreviewRow
                node={node}
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
          <InlineEditor
            editor={editor}
            setEditor={setEditor}
            onSave={saveEditor}
            onCancel={() => {
              setEditor(null);
              setError(null);
            }}
            onPickSender={() => setPickerFor({ kind: 'editor' })}
            faceOpen={faceOpen}
            setFaceOpen={setFaceOpen}
            error={error}
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
  onAvatar,
  onContextMenu,
}: {
  node: MfNode;
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
        title="右键 / 点击修改发送人"
        onClick={onAvatar}
        onContextMenu={(event) => {
          event.preventDefault();
          onAvatar();
        }}
      >
        {senderAvatarUrl(node.sender?.uin) ? (
          <img src={senderAvatarUrl(node.sender?.uin) ?? ''} alt="" loading="lazy" />
        ) : (
          <span className="weq-mf-avatar-fallback">{name.slice(0, 1)}</span>
        )}
        {widget ? <PendantLayer widget={widget} /> : null}
      </button>
      <div className="weq-forward-row-main weq-mf-row-main">
        <div className="weq-forward-row-meta weq-mf-row-meta">
          <span className="weq-forward-row-name weq-mf-row-name">{name}</span>
          <span className="weq-forward-row-time weq-mf-row-time">{formatNodeTime(node.time)}</span>
        </div>
        <div className="weq-forward-bubble weq-mf-bubble qq-bubble-shell">
          <QqMessageContent
            elements={node.elements as Array<{ type?: string; data?: Record<string, unknown> }>}
            sendTimeMs={(node.time || 0) * 1000}
            msgId={node.sourceMsgId ?? node.id}
          />
        </div>
      </div>
    </div>
  );
}

function PendantLayer({ widget }: { widget: ResolvedWidget }): ReactElement | null {
  if (widget.animated) {
    return <span className="weq-avatar-pendant-img" aria-hidden />;
  }
  return (
    <img
      className="weq-avatar-pendant-img"
      src={widget.url}
      alt=""
      aria-hidden
      draggable={false}
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}

function formatNodeTime(seconds: number): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 内联消息编辑器：文字 + 表情；已有的富元素（图片等）作为不可编辑的片段保留。 */
function InlineEditor({
  editor,
  setEditor,
  onSave,
  onCancel,
  onPickSender,
  faceOpen,
  setFaceOpen,
  error,
}: {
  editor: EditorState;
  setEditor: (updater: (cur: EditorState | null) => EditorState | null) => void;
  onSave: () => void;
  onCancel: () => void;
  onPickSender: () => void;
  faceOpen: boolean;
  setFaceOpen: (open: boolean) => void;
  error: string | null;
}): ReactElement {
  const textValue = useMemo(
    () =>
      editor.segs
        .filter((s): s is Extract<EditSeg, { k: 'text' }> => s.k === 'text')
        .map((s) => s.text)
        .join(''),
    [editor.segs],
  );

  const hasKeep = editor.segs.some((s) => s.k === 'keep');

  function setText(next: string): void {
    setEditor((cur) => {
      if (!cur) return cur;
      const others = cur.segs.filter((s) => s.k !== 'text');
      const segs: EditSeg[] = next.length > 0 ? [{ k: 'text', id: mfId('seg'), text: next }, ...others] : others;
      return { ...cur, segs };
    });
  }

  function addFace(faceId: number, faceText: string): void {
    setEditor((cur) =>
      cur ? { ...cur, segs: [...cur.segs, { k: 'face', id: mfId('seg'), faceId, faceText }] } : cur,
    );
  }

  return (
    <div className="weq-mf-inline-editor">
      <div className="weq-mf-inline-head">
        <button type="button" className="weq-mf-sender-chip" onClick={onPickSender} title="修改发送人">
          <img src={senderAvatarUrl(editor.sender.uin) ?? ''} alt="" />
          <span>{editor.sender.name || editor.sender.uin || '未命名'}</span>
        </button>
        <span className="weq-mf-inline-hint">回车换行，Ctrl/⌘ + 回车保存</span>
      </div>

      <textarea
        className="weq-mf-textarea"
        placeholder="输入消息内容…"
        value={textValue}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSave();
          }
        }}
      />

      {editor.segs.some((s) => s.k !== 'text') ? (
        <div className="weq-mf-segs">
          {editor.segs
            .filter((s) => s.k !== 'text')
            .map((seg) =>
              seg.k === 'face' ? (
                <span key={seg.id} className="weq-mf-chip">
                  <FaceEmoji element={{ faceId: seg.faceId, faceText: seg.faceText }} size={18} />
                  <span>{seg.faceText}</span>
                </span>
              ) : (
                <span key={seg.id} className="weq-mf-chip weq-mf-chip-keep">
                  <ImageIcon size={13} />
                  <span>{seg.el.type ?? '元素'}</span>
                </span>
              ),
            )}
        </div>
      ) : null}

      <div className="weq-mf-inline-tools">
        <button type="button" className={cn('weq-mf-tool', faceOpen && 'active')} onClick={() => setFaceOpen(!faceOpen)}>
          <Smile size={15} /> 表情
        </button>
        <span className="weq-mf-inline-spacer" />
        {hasKeep ? <span className="weq-mf-keep-note">含图片 / 文件，编辑文字不会丢掉它们</span> : null}
        <button type="button" className="weq-mf-soft" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="weq-mf-primary" onClick={onSave}>
          保存
        </button>
      </div>

      {faceOpen ? (
        <div className="weq-mf-face-pop">
          <FacePicker onPick={(f) => addFace(f.faceId, f.faceText)} />
        </div>
      ) : null}

      {error ? <div className="weq-mf-error">{error}</div> : null}
    </div>
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
  useEffect(() => {
    function close(): void {
      onClose();
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 170);
  const top = Math.min(y, window.innerHeight - 190);

  return createPortal(
    <div
      className="weq-mf-menu"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
      role="menu"
    >
      <button type="button" role="menuitem" onClick={onEdit}>
        <Pencil size={15} /> 修改内容
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