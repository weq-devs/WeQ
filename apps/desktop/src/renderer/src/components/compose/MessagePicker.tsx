/**
 * Message picker — lists a conversation's recent messages (via account.listLatest)
 * rendered faithfully with QqMessageContent, and lets the user click one. Used
 * for choosing a reply target (all messages) and for lifting an existing image
 * (`imagesOnly`).
 */

import { useMemo, type ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { QqAvatar } from '../QqAvatar';
import {
  QqMessageContent,
  ConvContext,
  ForwardKindContext,
} from '../QqMessageContent';
import type { RenderEl } from './composeModel';

export interface PickedMessage {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: RenderEl[];
}

export function MessagePicker({
  kind,
  conv,
  resolveName,
  onPick,
  imagesOnly = false,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  resolveName: (uid: string, uin: string) => string;
  onPick: (msg: PickedMessage) => void;
  imagesOnly?: boolean;
}): ReactElement {
  const query = trpc.account.listLatest.useQuery(
    { kind, conv, limit: 80 },
    { staleTime: 10_000 },
  );

  const messages = useMemo(() => {
    const rows = (query.data ?? []) as unknown as PickedMessage[];
    const list = imagesOnly
      ? rows.filter((m) => (m.elements ?? []).some((e) => e.type === 'pic'))
      : rows;
    // Newest first.
    return list;
  }, [query.data, imagesOnly]);

  return (
    <ForwardKindContext.Provider value={kind}>
      <ConvContext.Provider value={kind === 'group' ? conv : ''}>
        <div className="weq-msg-picker">
          {query.isLoading ? (
            <div className="weq-face-empty">加载中…</div>
          ) : messages.length === 0 ? (
            <div className="weq-face-empty">
              {imagesOnly ? '最近消息里没有图片' : '暂无消息'}
            </div>
          ) : (
            messages.map((m) => (
              <button
                key={m.msgId}
                type="button"
                className="weq-msg-row"
                onClick={() => onPick(m)}
              >
                <QqAvatar uin={m.senderUin} size={28} className="weq-msg-avatar" />
                <div className="weq-msg-main">
                  <div className="weq-msg-meta">
                    <span className="weq-msg-sender">
                      {resolveName(m.senderUid, m.senderUin)}
                    </span>
                    <span className="weq-msg-time">{fmtTime(m.sendTime)}</span>
                  </div>
                  <div className="weq-msg-preview">
                    <QqMessageContent
                      elements={m.elements ?? []}
                      sendTimeMs={Number(m.sendTime) * 1000}
                      msgId={m.msgId}
                    />
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </ConvContext.Provider>
    </ForwardKindContext.Provider>
  );
}

function fmtTime(sec: string): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
