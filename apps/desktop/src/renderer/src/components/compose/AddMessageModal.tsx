/**
 * AddMessageModal — author and insert a brand-new message into a conversation.
 *
 * Flow (single modal, sub-views instead of stacked popups):
 *   main → pick sender · toggle+pick reply · compose text/at/face/pic → 添加
 * At least one of text/at/face/pic is required; reply (if on) becomes the
 * leading element and flips msgType to 9 on the backend.
 *
 * Everything routes through `account.insertMessage`; avatars come from the uin
 * (never the DB's stale URLs).
 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  ArrowLeft,
  AtSign,
  CornerUpLeft,
  ImageIcon,
  Smile,
  Type as TypeIcon,
  X,
} from 'lucide-react';
import { Modal } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import {
  QqMessageContent,
  ConvContext,
  ForwardKindContext,
} from '../QqMessageContent';
import { FaceEmoji } from '../FaceEmoji';
import { client } from '../../trpc/client';
import type { Conversation, User } from '../../im-template/template/types';
import { FacePicker } from './FacePicker';
import { PeoplePicker, type Person } from './PeoplePicker';
import { MessagePicker, type PickedMessage } from './MessagePicker';
import {
  hasContent,
  nextId,
  summarize,
  toPreviewElements,
  toReplyElement,
  toWireElements,
  type ReplyTarget,
  type Segment,
} from './composeModel';

type View = 'main' | 'sender' | 'reply' | 'at' | 'face' | 'pic';

export function AddMessageModal({
  conversation,
  selfUser,
  selfUid,
  onClose,
  onInserted,
}: {
  conversation: Conversation;
  selfUser: User;
  /**
   * Real self uid (40020 senderUid) written to the DB. `selfUser.id` is only a
   * `self:${uin}` marker used by the chat view's "is this mine" checks, so it
   * must NOT be used as the sender uid.
   */
  selfUid?: string;
  onClose: () => void;
  onInserted?: () => void;
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const kind: 'c2c' | 'group' = isGroup ? 'group' : 'c2c';
  const conv = isGroup
    ? conversation.group.identityValue
    : conversation.otherUser.id;
  const peerUid = isGroup ? '' : conversation.otherUser.id;

  const self: Person = {
    uid: selfUid || selfUser.id,
    uin: selfUser.identityValue,
    name: selfUser.displayName || '我',
  };

  // Candidate people for the sender / @-mention pickers.
  const members: Person[] = useMemo(() => {
    if (!isGroup) return [];
    return conversation.members.map((m) => ({
      uid: m.id,
      uin: m.identityValue,
      name: m.displayName || m.identityValue,
    }));
  }, [conversation, isGroup]);

  const senderPeople: Person[] = useMemo(() => {
    if (isGroup) return dedupe([self, ...members]);
    return dedupe([self, personOf(conversation.otherUser)]);
  }, [self, members, conversation, isGroup]);

  const resolveName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [self, ...members]) map.set(p.uid, p.name);
    if (!isGroup) map.set(conversation.otherUser.id, conversation.otherUser.displayName);
    return (uid: string, uin: string) => map.get(uid) || uin || uid;
  }, [self, members, conversation, isGroup]);

  const [view, setView] = useState<View>('main');
  const [sender, setSender] = useState<Person>(self);
  const [replyOn, setReplyOn] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewEls = useMemo(() => toPreviewElements(segments), [segments]);

  function addSegment(seg: Segment): void {
    setSegments((prev) => [...prev, seg]);
    setError(null);
  }
  function removeSegment(id: string): void {
    setSegments((prev) => prev.filter((s) => s.id !== id));
  }
  function updateText(id: string, text: string): void {
    setSegments((prev) => prev.map((s) => (s.id === id && s.t === 'text' ? { ...s, text } : s)));
  }

  async function pickImage(msg: PickedMessage): Promise<void> {
    try {
      const raw = await client.account.getRawElements.query({ msgId: msg.msgId });
      const picCodec = raw?.elements?.find((e: { kind?: string }) => e.kind === 'pic') as
        | Record<string, unknown>
        | undefined;
      const picPreview = (msg.elements ?? []).find((e) => e.type === 'pic');
      if (!picCodec || !picPreview) {
        setError('这条消息里没有可用的图片');
        setView('main');
        return;
      }
      addSegment({ t: 'pic', id: nextId(), codec: picCodec, preview: picPreview });
      setView('main');
    } catch {
      setError('读取图片失败');
      setView('main');
    }
  }

  async function submit(): Promise<void> {
    if (replyOn && !replyTarget) {
      setError('请选择要回复的消息');
      return;
    }
    if (!hasContent(segments)) {
      setError('至少添加一个内容（文字 / @ / 表情 / 图片）');
      return;
    }
    const elements: Array<Record<string, unknown>> = [];
    if (replyOn && replyTarget) elements.push(toReplyElement(replyTarget, peerUid));
    elements.push(...toWireElements(segments));

    setSubmitting(true);
    setError(null);
    try {
      const res = await client.account.insertMessage.mutate({
        kind,
        conv,
        senderUid: sender.uid,
        senderUin: sender.uin,
        elements,
      });
      if (!res) {
        setError('插入失败：该会话没有可参照的历史消息');
        setSubmitting(false);
        return;
      }
      onInserted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入失败');
      setSubmitting(false);
    }
  }

  const subtitle = isGroup ? conversation.group.name : conversation.otherUser.displayName;

  return (
    <Modal onClose={onClose} width={430} labelledBy="weq-compose-title">
      <div className="weq-compose">
        <header className="weq-compose-head">
          {view === 'main' ? (
            <>
              <div className="weq-compose-titlewrap">
                <strong id="weq-compose-title" className="weq-compose-title">添加消息</strong>
                <span className="weq-compose-sub">{subtitle}</span>
              </div>
              <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
                <X size={17} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="weq-compose-x" onClick={() => setView('main')} title="返回">
                <ArrowLeft size={17} />
              </button>
              <strong className="weq-compose-title">{VIEW_TITLE[view]}</strong>
              <span className="weq-compose-headspacer" />
            </>
          )}
        </header>

        {view === 'main' ? (
          <div className="weq-compose-body">
            {/* Sender */}
            <div className="weq-compose-section">
              <label className="weq-compose-label">发送人</label>
              <button type="button" className="weq-compose-sender" onClick={() => setView('sender')}>
                <QqAvatar uin={sender.uin} size={34} />
                <span className="weq-compose-sender-name">{sender.name}</span>
                {sender.uin && sender.uin !== '0' ? (
                  <span className="weq-compose-sender-uin">{sender.uin}</span>
                ) : null}
                <span className="weq-compose-sender-swap">切换</span>
              </button>
            </div>

            {/* Reply */}
            <div className="weq-compose-section">
              <label className="weq-compose-checkline">
                <input
                  type="checkbox"
                  checked={replyOn}
                  onChange={(e) => {
                    setReplyOn(e.target.checked);
                    if (!e.target.checked) setReplyTarget(null);
                  }}
                />
                <CornerUpLeft size={14} />
                <span>回复一条消息</span>
              </label>
              {replyOn ? (
                replyTarget ? (
                  <button type="button" className="weq-compose-reply-card" onClick={() => setView('reply')}>
                    <span className="weq-compose-reply-sender">
                      {resolveName(replyTarget.senderUid, replyTarget.senderUin)}
                    </span>
                    <span className="weq-compose-reply-text">{replyTarget.summary}</span>
                    <span className="weq-compose-sender-swap">更换</span>
                  </button>
                ) : (
                  <button type="button" className="weq-compose-pick-btn" onClick={() => setView('reply')}>
                    选择要回复的消息
                  </button>
                )
              ) : null}
            </div>

            {/* Content */}
            <div className="weq-compose-section">
              <label className="weq-compose-label">消息内容</label>
              {previewEls.length > 0 ? (
                <ForwardKindContext.Provider value={kind}>
                  <ConvContext.Provider value={isGroup ? conv : ''}>
                    <div className="weq-compose-preview">
                      <QqMessageContent elements={previewEls} sendTimeMs={0} msgId="" />
                    </div>
                  </ConvContext.Provider>
                </ForwardKindContext.Provider>
              ) : null}

              <div className="weq-compose-segs">
                {segments.length === 0 ? (
                  <div className="weq-compose-segs-empty">用下方按钮添加文字、表情{isGroup ? '、@成员' : ''}或图片</div>
                ) : (
                  segments.map((s) => (
                    <SegmentRow
                      key={s.id}
                      seg={s}
                      onText={(t) => updateText(s.id, t)}
                      onRemove={() => removeSegment(s.id)}
                    />
                  ))
                )}
              </div>

              <div className="weq-compose-tools">
                <button
                  type="button"
                  className="weq-compose-tool"
                  onClick={() => addSegment({ t: 'text', id: nextId(), text: '' })}
                >
                  <TypeIcon size={15} /> 文字
                </button>
                {isGroup ? (
                  <button type="button" className="weq-compose-tool" onClick={() => setView('at')}>
                    <AtSign size={15} /> 提及
                  </button>
                ) : null}
                <button type="button" className="weq-compose-tool" onClick={() => setView('face')}>
                  <Smile size={15} /> 表情
                </button>
                <button type="button" className="weq-compose-tool" onClick={() => setView('pic')}>
                  <ImageIcon size={15} /> 图片
                </button>
              </div>
            </div>

            {error ? <div className="weq-compose-error">{error}</div> : null}

            <footer className="weq-compose-foot">
              <button type="button" className="weq-action-soft" onClick={onClose} disabled={submitting}>
                取消
              </button>
              <button type="button" className="weq-action-primary" onClick={submit} disabled={submitting}>
                {submitting ? '添加中…' : '添加消息'}
              </button>
            </footer>
          </div>
        ) : (
          <div className="weq-compose-picker">
            {view === 'sender' ? (
              <PeoplePicker
                people={senderPeople}
                onPick={(p) => {
                  setSender(p);
                  setView('main');
                }}
              />
            ) : null}
            {view === 'at' ? (
              <PeoplePicker
                people={members}
                onPick={(p) => {
                  addSegment({ t: 'at', id: nextId(), uid: p.uid, uin: p.uin, name: p.name });
                  setView('main');
                }}
              />
            ) : null}
            {view === 'face' ? (
              <FacePicker
                onPick={(f) => {
                  addSegment({ t: 'face', id: nextId(), faceId: f.faceId, faceText: f.faceText });
                  setView('main');
                }}
              />
            ) : null}
            {view === 'reply' ? (
              <MessagePicker
                kind={kind}
                conv={conv}
                resolveName={resolveName}
                onPick={(m) => {
                  setReplyTarget({
                    msgId: m.msgId,
                    msgSeq: m.msgSeq,
                    senderUid: m.senderUid,
                    senderUin: m.senderUin,
                    sendTime: m.sendTime,
                    summary: summarize(m.elements ?? []),
                  });
                  setView('main');
                }}
              />
            ) : null}
            {view === 'pic' ? (
              <MessagePicker
                kind={kind}
                conv={conv}
                resolveName={resolveName}
                imagesOnly
                onPick={(m) => void pickImage(m)}
              />
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

const VIEW_TITLE: Record<View, string> = {
  main: '添加消息',
  sender: '选择发送人',
  reply: '选择要回复的消息',
  at: '选择要提及的成员',
  face: '选择表情',
  pic: '选择一张图片',
};

/** One authored segment: editable input for text, a removable chip otherwise. */
function SegmentRow({
  seg,
  onText,
  onRemove,
}: {
  seg: Segment;
  onText: (text: string) => void;
  onRemove: () => void;
}): ReactElement {
  if (seg.t === 'text') {
    return (
      <div className="weq-compose-seg weq-compose-seg-text">
        <input
          className="weq-compose-textinput"
          value={seg.text}
          placeholder="输入文字…"
          onChange={(e) => onText(e.target.value)}
          autoFocus
        />
        <button type="button" className="weq-compose-seg-x" onClick={onRemove} title="删除">
          <X size={13} />
        </button>
      </div>
    );
  }
  return (
    <div className="weq-compose-seg weq-compose-chip">
      <span className="weq-compose-chip-body">
        {seg.t === 'at' ? (
          <span className="weq-compose-chip-at">@{seg.name}</span>
        ) : seg.t === 'face' ? (
          <>
            <FaceEmoji element={{ faceId: seg.faceId, faceText: seg.faceText }} size={20} />
            <span className="weq-compose-chip-label">{seg.faceText}</span>
          </>
        ) : (
          <>
            <ImageIcon size={14} />
            <span className="weq-compose-chip-label">图片</span>
          </>
        )}
      </span>
      <button type="button" className="weq-compose-seg-x" onClick={onRemove} title="删除">
        <X size={13} />
      </button>
    </div>
  );
}

function personOf(u: User): Person {
  return { uid: u.id, uin: u.identityValue, name: u.displayName || u.identityValue };
}

function dedupe(list: Person[]): Person[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = p.uid || p.uin;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
