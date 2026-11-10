import { createContext, useContext } from 'react';
import { beijingDay } from '../lib/messageCalendar';
import '../styles/message-metadata.css';

export const ShowMessageSeqContext = createContext(false);
export const ShowMessageDateContext = createContext(false);
export const ShowMessageTimeContext = createContext(false);

export function MessageProvenance({
  message,
  system = false,
}: {
  message: {
    msgSeq?: string;
    createdAt?: string;
    source?: 'roaming';
    sourceFormat?: 'native' | 'protocol';
    localSent?: boolean;
  };
  system?: boolean;
}) {
  const showSeq = useContext(ShowMessageSeqContext);
  const showDate = useContext(ShowMessageDateContext);
  const showTime = useContext(ShowMessageTimeContext);
  const seq =
    !system && showSeq && /^\d+$/.test(message.msgSeq ?? '') && BigInt(message.msgSeq!) > 0n
      ? message.msgSeq
      : null;
  const date = message.createdAt ? new Date(message.createdAt) : null;
  const day = showDate && date && Number.isFinite(date.getTime()) ? beijingDay(date) : null;
  const time =
    showTime && date && Number.isFinite(date.getTime())
      ? date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
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
        <time dateTime={message.createdAt} title="发送日期与时间（北京时间）">
          {[day, time].filter(Boolean).join(' ')}
        </time>
      ) : null}
    </span>
  );
}
