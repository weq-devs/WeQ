import { createContext, useContext } from 'react';

export const ShowMessageSeqContext = createContext(false);

export function MessageProvenance({
  message,
}: {
  message: { msgSeq?: string; source?: 'roaming'; sourceFormat?: 'native' | 'protocol' };
}) {
  const showSeq = useContext(ShowMessageSeqContext);
  const seq =
    showSeq && /^\d+$/.test(message.msgSeq ?? '') && BigInt(message.msgSeq!) > 0n
      ? message.msgSeq
      : null;
  if (message.source !== 'roaming' && !seq) return null;
  return (
    <div className="weq-message-provenance">
      {message.source === 'roaming' ? (
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
    </div>
  );
}
