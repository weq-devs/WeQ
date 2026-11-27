import { useEffect, useMemo, useRef, useState } from 'react';
import { FaceSubType } from '@weq/codec';
import type { Conversation, User } from '../im-template/template/types';
import { toWireElements } from './compose/composeModel';
import { MessageSegmentsEditor } from './mergeForward/MergeForwardComposer';
import {
  codecElementToSeg,
  mfId,
  segHasContent,
  type MfSeg,
  type MfSegKind,
} from './mergeForward/model';
import type { MfPerson } from './mergeForward/SenderPicker';

type EditableElement = Readonly<Record<string, unknown>> & { kind: string };
const editableKinds: MfSegKind[] = ['text', 'face', 'ark', 'markdown'];
const groupEditableKinds: MfSegKind[] = ['text', 'at', ...editableKinds.slice(1)];

function person(user: User): MfPerson {
  return {
    uid: user.uid ?? (user.id.startsWith('self:') ? '' : user.id),
    uin: user.identityValue,
    name: user.displayName,
  };
}

function fromElement(element: EditableElement, group: boolean): MfSeg {
  switch (element.kind) {
    case 'text':
    case 'face':
    case 'ark':
    case 'markdown':
    case 'at': {
      if (element.kind === 'at' && !group) break;
      if (element.kind === 'markdown' && element.flashTransferInfo) break;
      if (
        element.kind === 'face' &&
        typeof element.subType === 'number' &&
        element.subType > FaceSubType.QQ_BUILTIN_NEW
      )
        break;
      const seg = codecElementToSeg(element);
      if (seg?.t === 'at') return { ...seg, all: seg.uid === 'all' };
      if (seg && seg.t !== 'card') return seg;
      break;
    }
  }
  return {
    t: 'opaque',
    id: mfId('seg'),
    element: { type: element.kind, data: element },
  };
}

function editedElement(seg: MfSeg, original?: EditableElement): EditableElement | undefined {
  if (seg.t === 'text' ? !seg.text : !segHasContent(seg)) return undefined;
  switch (seg.t) {
    case 'text':
      return { ...original, kind: 'text', textContent: seg.text, urlVerifyFlag: undefined };
    case 'at': {
      if (!seg.uid) throw new Error('请选择群成员或填写被提及者的 UID。');
      const [encoded] = toWireElements([seg]);
      return { ...original, ...encoded, kind: 'at' };
    }
    case 'face':
      return {
        kind: 'face',
        elementId: original?.elementId,
        isSender: original?.isSender,
        faceId: seg.faceId,
        faceText: seg.faceText,
        subType: seg.faceId >= 260 ? FaceSubType.QQ_BUILTIN_NEW : FaceSubType.QQ_BUILTIN_OLD,
      };
    case 'ark': {
      let payload: unknown;
      try {
        payload = JSON.parse(seg.arkData);
      } catch {
        throw new Error('请输入有效的 JSON 卡片。');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('卡片内容应为一个 JSON 对象。');
      return {
        ...original,
        kind: 'ark',
        arkData: seg.arkData,
        arkSignature: undefined,
      };
    }
    case 'markdown':
      return {
        ...original,
        kind: 'markdown',
        markdownContent: seg.content,
        markdownContent49099: undefined,
        markdownTextSummary: seg.content,
      };
    default:
      return original;
  }
}

export default function LocalMessageEditor({
  elements,
  user,
  conversation,
  saving,
  onSave,
  onCancel,
}: {
  elements: readonly EditableElement[];
  user: User;
  conversation?: Conversation;
  saving: boolean;
  onSave: (elements: EditableElement[]) => Promise<void>;
  onCancel: () => void;
}) {
  const group = conversation?.type === 'group';
  const [originals] = useState(
    () =>
      new Map(
        elements.map((element) => {
          const segment = fromElement(element, group);
          return [segment.id, { segment, element }];
        }),
      ),
  );
  const [segs, setSegs] = useState(() => Array.from(originals.values(), ({ segment }) => segment));
  const [error, setError] = useState<string>();
  const self = useMemo(() => person(user), [user]);
  const members = useMemo(
    () => (conversation?.type === 'group' ? conversation.members.map(person) : undefined),
    [conversation],
  );
  const fields = useRef<HTMLFieldSetElement>(null);
  useEffect(() => fields.current?.focus({ preventScroll: true }), []);

  async function save() {
    if (saving) return;
    setError(undefined);
    try {
      const next = segs.flatMap((seg) => {
        const original = originals.get(seg.id);
        const element =
          original?.segment === seg ? original.element : editedElement(seg, original?.element);
        return element ? [element] : [];
      });
      if (!next.length) throw new Error('请至少保留一段消息内容。');
      if (
        next.length === elements.length &&
        next.every((element, index) => element === elements[index])
      ) {
        onCancel();
        return;
      }
      await onSave(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="weq-mf-inline-editor weq-message-detail-visual-editor">
      <fieldset
        ref={fields}
        className="weq-message-detail-visual-fields"
        aria-label="编辑本地记录"
        disabled={saving}
        tabIndex={-1}
      >
        <MessageSegmentsEditor
          segs={segs}
          kinds={group ? groupEditableKinds : editableKinds}
          onChange={setSegs}
          onSave={() => void save()}
          self={self}
          members={members}
          senderMode="conversation"
          renderOpaque={() => <p className="weq-mf-note">保留原始内容</p>}
          tools={
            <>
              <button type="button" className="weq-set-btn" disabled={saving} onClick={onCancel}>
                取消
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存本地记录'}
              </button>
            </>
          }
        />
      </fieldset>
      {error ? (
        <div className="weq-mf-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
