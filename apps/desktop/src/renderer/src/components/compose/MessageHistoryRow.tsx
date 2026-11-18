import type { ReactNode } from 'react';
import type { Message } from '../../im-template/template/types';
import { usePrivacyStore } from '../../state/privacy';

export function MessageHistoryRow({
  icon,
  label,
  detail,
  time,
  message,
  onLocate,
  unavailableReason,
  action,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  time: string;
  message: Message;
  onLocate?: (seq: string, messageId: string) => void;
  unavailableReason?: string;
  action?: ReactNode;
}) {
  const privacy = usePrivacyStore((state) => state.effective);
  const { msgSeq } = message;
  const locate =
    onLocate &&
    !unavailableReason &&
    msgSeq &&
    /^[1-9]\d*$/.test(msgSeq) &&
    (message.sourceFormat !== 'protocol' || message.ntSeqVerified)
      ? () => onLocate(msgSeq, message.id)
      : undefined;
  const hint = locate ? '定位到原消息' : (unavailableReason ?? '没有可定位的消息位置');
  const summary = message.body.replace(/\s+/g, ' ').trim() || '消息';
  const Row = locate ? 'button' : 'div';
  return (
    <li className="weq-history-record">
      <Row
        className="weq-history-summary"
        type={locate ? 'button' : undefined}
        title={[!privacy && detail, time, hint].filter(Boolean).join(' · ')}
        aria-label={
          locate
            ? [!privacy && detail, time, !privacy && summary, hint].filter(Boolean).join('，')
            : undefined
        }
        onClick={locate}
      >
        <span className="weq-history-record-icon" aria-hidden>
          {icon}
        </span>
        <strong className="weq-important-sender" data-privacy-sensitive>
          {label}
        </strong>
        <span className="weq-important-preview" data-privacy-sensitive>
          {summary}
        </span>
      </Row>
      {action}
    </li>
  );
}
