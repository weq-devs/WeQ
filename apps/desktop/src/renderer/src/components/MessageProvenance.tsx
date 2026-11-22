import { TimeLabel } from './TimeLabel';
import { clockFormatter, formatDateTime } from '@weq/time';
import { useContext, type ReactNode } from 'react';
import { beijingDay } from '../lib/messageCalendar';
import { useOutgoingMetadataMotion } from '../hooks/useOutgoingMetadataMotion';
import type { Message } from '../im-template/template/types';
import '../styles/message-metadata.css';
import {
  ShowMessageDateContext,
  ShowMessageTimeContext,
  ShowMessageSeqContext,
  messageSequence,
  showsRoamingSource,
} from './MessageProvenance.shared';

type MessageMetadataSource = Partial<
  Pick<Message, 'msgSeq' | 'createdAt' | 'source' | 'sourceFormat' | 'localSent' | 'recall'>
>;

/** 使用共用提示宿主展示逐条时间，不给正文增加常驻元信息或拦截人名操作。 */
export function SystemMessageContent({
  message,
  children,
}: {
  message: MessageMetadataSource;
  children?: ReactNode;
}) {
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const full = showDate || showTime ? formatDateTime(message.createdAt, 'second') : '';
  return (
    <div className="weq-system-message-content" title={full ? `${full}（北京时间）` : undefined}>
      {children}
      <MessageProvenance message={message} system />
    </div>
  );
}

export function MessageProvenance({
  message,
  system = false,
  precision = 'second',
  animate = false,
}: {
  message: MessageMetadataSource;
  system?: boolean;
  precision?: 'second' | 'millisecond';
  animate?: boolean;
}) {
  const showSeq = useContext(ShowMessageSeqContext);
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const seq = !system && showSeq ? messageSequence(message.msgSeq) : null;
  const date = message.createdAt ? new Date(message.createdAt) : null;
  const day =
    !system && showDate && date && Number.isFinite(date.getTime()) ? beijingDay(date) : null;
  const time =
    !system && showTime && date && Number.isFinite(date.getTime())
      ? clockFormatter.format(date)
      : null;
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
      {seq ? (
        <span ref={seqRef} className="weq-message-seq" title="会话内消息序号">
          seq <span className="weq-number weq-number-inherit">{seq}</span>
        </span>
      ) : null}
      {day || time ? (
        <TimeLabel ref={timeRef} value={message.createdAt} precision={precision} tabbable={false}>
          {timeText}
        </TimeLabel>
      ) : null}
    </span>
  );
}
