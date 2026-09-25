/**
 * AddMessageModal — author and insert a brand-new message into a conversation.
 *
 * Flow (single modal, sub-views instead of stacked popups):
 *   main → pick sender · toggle+pick reply · compose text/at/face/pic → 添加
 * At least one of text/at/face/pic is required; reply (if on) becomes the
 * leading element and flips msgType to 9 on the backend.
 *
 * Pictures come from a **local file** (`account.pickComposeImage`): the main
 * process copies the chosen image into QQ's own Pic cache and hands back a ready
 * pic element. Choosing a picture out of the conversation's history is gone — it
 * could only re-send an image someone had already sent.
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
import { QqMessageContent, ConvContext, ForwardKindContext } from '../QqMessageContent';
import { FaceEmoji } from '../FaceEmoji';
import { client } from '../../trpc/client';
import type { Conversation, User } from '../../im-template/template/types';
import { FacePicker } from './FacePicker';
import { PeoplePicker, type Person } from './PeoplePicker';
import { MessagePicker, type PickedMessage } from './MessagePicker';
import {
  hasContent,
  nextId,
  replyTrailingIsPic,
  summarize,
  toPreviewElements,
  toReplyElement,
  toReplyOrigElements,
  toWireElements,
  type RenderEl,
  type ReplyTarget,
  type Segment,
} from './composeModel';

type View = 'main' | 'sender' | 'reply' | 'at' | 'face';

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
    ? (conversation.group?.identityValue ?? '')
    : (conversation.otherUser?.id ?? '');
  const peerUid = isGroup ? '' : (conversation.otherUser?.id ?? '');

  const self: Person = useMemo(
    () => ({
      uid: selfUid || selfUser.id,
      uin: selfUser.identityValue,
      name: selfUser.displayName || '我',
    }),
    [selfUid, selfUser],
  );

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
    return dedupe([self, ...(conversation.otherUser ? [personOf(conversation.otherUser)] : [])]);
  }, [self, members, conversation, isGroup]);

  const resolveName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [self, ...members]) map.set(p.uid, p.name);
    if (!isGroup && conversation.otherUser)
      map.set(conversation.otherUser.id, conversation.otherUser.displayName);
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

  // 预览要按图片落盘时那一刻去找图（月份要对上），否则会画不出来。
  const previewSendTimeMs = useMemo(() => {
    const pic = segments.find((s) => s.t === 'pic');
    return pic ? pic.sendTimeMs : 0;
  }, [segments]);

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

  /**
   * Commit a reply target. When the quoted message ends in an image, lift the
   * real `pic` element (getRawElements → editable wire) into origElements so the
   * stored quote renders an actual thumbnail; otherwise carry the trailing
   * text/@/face run. Any lift failure degrades to the bracket-label preview.
   */
  async function pickReply(m: PickedMessage): Promise<void> {
    const base: ReplyTarget = {
      msgId: m.msgId,
      msgSeq: m.msgSeq,
      senderUid: m.senderUid,
      senderUin: m.senderUin,
      sendTime: m.sendTime,
      summary: summarize(m.elements ?? []),
      origElements: toReplyOrigElements(m.elements ?? []),
    };
    if (replyTrailingIsPic(m.elements ?? [])) {
      try {
        const raw = await client.account.getRawElements.query({ msgId: m.msgId });
        // The trailing image — findLast, not find: a multi-image message quotes
        // its LAST picture (the one the preview rule selected).
        const pics = (raw?.elements ?? []).filter((e: { kind?: string }) => e.kind === 'pic');
        const picCodec = pics[pics.length - 1] as Record<string, unknown> | undefined;
        if (picCodec) base.origElements = [picCodec];
      } catch {
        /* keep the bracket-label fallback from toReplyOrigElements */
      }
    }
    setReplyTarget(base);
    setView('main');
  }

  /**
   * 选一张**本机图片**。主进程把它按 QQ 自己的命名规则拷进图片缓存
   * （`nt_data/Pic/<当月>/Ori/<md5>.<ext>`）并回一个可直接插进消息的 pic 元素 ——
   * 聊天渲染走 `weq-media://pic`，正是按「发送时间推月份 + 文件名」去那个目录找图，
   * 所以落进缓存就意味着能画出来。
   *
   * 返回的 `sendTime` 同时被预览和 `insertMessage` 使用，必须一致；已经选过图时把它
   * 传下去，让后面的图跟着落进同一个月（整条消息只有一个时间戳）。
   */
  async function pickLocalImage(): Promise<void> {
    try {
      const staged = await client.account.pickComposeImage.mutate({
        sendTime: picSegmentSendTime(segments),
      });
      if (!staged) return; // 用户在文件框里点了取消
      addSegment({
        t: 'pic',
        id: nextId(),
        codec: staged.element as Record<string, unknown>,
        preview: staged.preview as RenderEl,
        sendTimeMs: staged.sendTime * 1000,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入图片失败');
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

    // 图片拷进的是「选图那一刻」的月份目录，消息时间得跟着它一起走。
    const sendTime = picSegmentSendTime(segments);

    setSubmitting(true);
    setError(null);
    try {
      const res = await client.account.insertMessage.mutate({
        kind,
        conv,
        senderUid: sender.uid,
        senderUin: sender.uin,
        elements,
        ...(sendTime ? { sendTime } : {}),
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

  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  return (
    <Modal onClose={onClose} width={430} labelledBy="weq-compose-title">
      <div className="weq-compose">
        <header className="weq-compose-head">
          {view === 'main' ? (
            <>
              <div className="weq-compose-titlewrap">
                <strong id="weq-compose-title" className="weq-compose-title">
                  添加消息
                </strong>
                <span className="weq-compose-sub">{subtitle}</span>
              </div>
              <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
                <X size={17} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="weq-compose-x"
                onClick={() => setView('main')}
                title="返回"
              >
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
              <button
                type="button"
                className="weq-compose-sender"
                onClick={() => setView('sender')}
              >
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
                  <button
                    type="button"
                    className="weq-compose-reply-card"
                    onClick={() => setView('reply')}
                  >
                    <span className="weq-compose-reply-sender">
                      {resolveName(replyTarget.senderUid, replyTarget.senderUin)}
                    </span>
                    <span className="weq-compose-reply-text">{replyTarget.summary}</span>
                    <span className="weq-compose-sender-swap">更换</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="weq-compose-pick-btn"
                    onClick={() => setView('reply')}
                  >
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
                      <QqMessageContent
                        elements={previewEls}
                        sendTimeMs={previewSendTimeMs}
                        msgId=""
                      />
                    </div>
                  </ConvContext.Provider>
                </ForwardKindContext.Provider>
              ) : null}

              <div className="weq-compose-segs">
                {segments.length === 0 ? (
                  <div className="weq-compose-segs-empty">
                    用下方按钮添加文字、表情{isGroup ? '、@成员' : ''}或图片
                  </div>
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
                <button
                  type="button"
                  className="weq-compose-tool"
                  onClick={() => void pickLocalImage()}
                >
                  <ImageIcon size={15} /> 图片
                </button>
              </div>
            </div>

            {error ? <div className="weq-compose-error">{error}</div> : null}

            <footer className="weq-compose-foot">
              <button
                type="button"
                className="weq-action-soft"
                onClick={onClose}
                disabled={submitting}
              >
                取消
              </button>
              <button
                type="button"
                className="weq-action-primary"
                onClick={submit}
                disabled={submitting}
              >
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
                onPick={(m) => void pickReply(m)}
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
};

/** 消息时间要锚在第一张图落盘那一刻（unix 秒）；第二张图会跟着复制这个时间。 */
function picSegmentSendTime(segments: Segment[]): number | undefined {
  const pic = segments.find((s) => s.t === 'pic');
  return pic ? Math.floor(pic.sendTimeMs / 1000) : undefined;
}

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
