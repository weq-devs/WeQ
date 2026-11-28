import { TimeLabel } from './TimeLabel';
import { clockFormatter, formatDateTime, timeDate } from '@weq/time';
import { useContext, type ReactNode, type Ref } from 'react';
import { beijingDay } from '../lib/messageCalendar';
import { useOutgoingMetadataMotion } from '../hooks/useOutgoingMetadataMotion';
import type { Message } from '../im-template/template/types';
import '../styles/message-metadata.css';
import { CopyButton } from './CopyButton';
import {
  ShowMessageDateContext,
  ShowMessageTimeContext,
  ShowMessageSeqContext,
  messageSequence,
  showsRoamingSource,
  type MessageProvenanceSource,
} from './MessageProvenance.shared';

type MessageMetadataSource = Partial<
  Pick<Message, 'msgSeq' | 'createdAt' | 'sourceFormat'> & MessageProvenanceSource
>;

export function MessageSequenceLabel({
  seq,
  ref,
  inMenu = false,
}: {
  seq: string;
  ref?: Ref<HTMLSpanElement>;
  inMenu?: boolean;
}) {
  return (
    <span ref={ref} className="weq-message-seq">
      seq{' '}
      <CopyButton
        text={seq}
        className="weq-message-seq-copy weq-number weq-number-inherit"
        title="复制消息序号"
        aria-label={`复制消息序号 ${seq}`}
        role={inMenu ? 'menuitem' : undefined}
        tabIndex={inMenu ? -1 : undefined}
      >
        {seq}
      </CopyButton>
    </span>
  );
}

/** 系统提示沿用时间提示；独立记录也可以在行内显示时间。 */
export function SystemMessageContent({
  message,
  children,
  alwaysShowTime = false,
  alwaysShowDate = false,
}: {
  message: MessageMetadataSource;
  children?: ReactNode;
  alwaysShowTime?: boolean;
  alwaysShowDate?: boolean;
}) {
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const full =
    showDate || showTime || alwaysShowTime || alwaysShowDate
      ? formatDateTime(message.createdAt, 'second')
      : '';
  return (
    <div className="weq-system-message-content" title={full ? `${full}（北京时间）` : undefined}>
      {children}
      <MessageProvenance
        message={message}
        system
        alwaysShowTime={alwaysShowTime}
        alwaysShowDate={alwaysShowDate}
      />
    </div>
  );
}

export function MessageProvenance({
  message,
  system = false,
  precision = 'second',
  animate = false,
  alwaysShowTime = false,
  alwaysShowDate = false,
  showSequence = true,
}: {
  message: MessageMetadataSource;
  system?: boolean;
  precision?: 'second' | 'millisecond';
  animate?: boolean;
  /** 结果与选区中的消息需要可独立识别。 */
  alwaysShowTime?: boolean;
  alwaysShowDate?: boolean;
  showSequence?: boolean;
}) {
  const showSeq = useContext(ShowMessageSeqContext);
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const seq = !system && showSeq && showSequence ? messageSequence(message.msgSeq) : null;
  const date = timeDate(message.createdAt);
  const includeDate = alwaysShowDate || (showDate && (!system || alwaysShowTime));
  const day = date && includeDate ? beijingDay(date) : null;
  const time =
    date && (alwaysShowTime || (showTime && !system)) ? clockFormatter.format(date) : null;
  const timeText = [day, time].filter(Boolean).join(' ');
  const seqRef = useOutgoingMetadataMotion<HTMLSpanElement>(seq, animate);
  const timeRef = useOutgoingMetadataMotion<HTMLTimeElement>(timeText || null, animate);
  const roaming = showsRoamingSource(message);
  if (!roaming && !seq && !day && !time) return null;
  return (
    <span className="weq-message-provenance">
      {roaming ? (
        <span
          title={
            message.sourceFormat === 'native'
              ? '来自原生 QQ SDK 的漫游记录；QQ 可能自行更新客户端缓存'
              : '来自 WeQ 漫游缓存，未写入 QQ 原始数据库'
          }
        >
          漫游
        </span>
      ) : null}
      {seq ? <MessageSequenceLabel seq={seq} ref={seqRef} /> : null}
      {day || time ? (
        <TimeLabel ref={timeRef} value={message.createdAt} precision={precision} tabbable={false}>
          {timeText}
        </TimeLabel>
      ) : null}
    </span>
  );
}
