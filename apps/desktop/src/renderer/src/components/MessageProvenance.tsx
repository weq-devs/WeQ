import { TimeLabel } from './TimeLabel';
import { clockFormatter, formatDateTime } from '@weq/time';
import { createContext, useContext, type ReactNode } from 'react';
import { beijingDay } from '../lib/messageCalendar';
import '../styles/message-metadata.css';

export const ShowMessageSeqContext = createContext(false);
export const ShowMessageDateContext = createContext(false);
export const ShowMessageTimeContext = createContext(false);

type MessageMetadataSource = {
  msgSeq?: string;
  createdAt?: string;
  source?: 'roaming';
  sourceFormat?: 'native' | 'protocol';
  localSent?: boolean;
};

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
    <div
      className="weq-system-message-content"
      title={full ? `${full}（北京时间）` : undefined}
      tabIndex={full ? 0 : undefined}
    >
      {children}
      <MessageProvenance message={message} system />
    </div>
  );
}

export function MessageProvenance({
  message,
  system = false,
  precision = 'second',
}: {
  message: MessageMetadataSource;
  system?: boolean;
  precision?: 'second' | 'millisecond';
}) {
  const showSeq = useContext(ShowMessageSeqContext);
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const seq =
    !system && showSeq && /^\d+$/.test(message.msgSeq ?? '') && BigInt(message.msgSeq!) > 0n
      ? message.msgSeq
      : null;
  const date = message.createdAt ? new Date(message.createdAt) : null;
  const day =
    !system && showDate && date && Number.isFinite(date.getTime()) ? beijingDay(date) : null;
  const time =
    !system && showTime && date && Number.isFinite(date.getTime())
      ? clockFormatter.format(date)
      : null;
  const roaming = message.source === 'roaming' && !message.localSent;
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
        <span className="weq-message-seq" title="会话内消息序号">
          seq {seq}
        </span>
      ) : null}
      {day || time ? (
        <TimeLabel value={message.createdAt} precision={precision}>
          {[day, time].filter(Boolean).join(' ')}
        </TimeLabel>
      ) : null}
    </span>
  );
}
