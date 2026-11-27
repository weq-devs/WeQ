import { useContext } from 'react';
import type { Conversation, Message } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { formatBytes } from '../lib/format';
import {
  FileTransferTipScopeContext,
  ReplyJumpContext,
  type FileTransferTipScope,
} from '../state/messageContext';
import { trpc } from '../trpc/client';

interface GrayTipFileRecvMessageProps {
  conversation?: Conversation;
  message?: Message;
  element: {
    type: 'grayTipFileRecv';
    data?: {
      fileName?: string;
      fileSize?: number;
      fileToken?: string;
    };
  };
}

export function GrayTipFileRecvMessage({
  element,
  conversation,
  message,
}: GrayTipFileRecvMessageProps) {
  const scope = useContext(FileTransferTipScopeContext);
  const { fileName, fileSize, fileToken } = element.data ?? {};
  if (!fileName) return null;
  const tipSeq = Number(message?.msgSeq);
  const tipId = message?.msgId;
  if (
    scope &&
    conversation?.id === scope.conv &&
    message?.conversationId === scope.conv &&
    !message.forwardSnapshot &&
    fileToken &&
    tipId &&
    /^-?[1-9]\d{0,19}$/.test(tipId) &&
    Number.isInteger(tipSeq) &&
    tipSeq > 0 &&
    tipSeq <= 0xffffffff
  ) {
    return (
      <ResolvedFileTransferTip
        input={{ ...scope, tipId, tipSeq }}
        peer={conversation.type === 'direct' ? displayUserName(conversation.otherUser) : ''}
        fileName={fileName}
        fileSize={fileSize}
      />
    );
  }
  return <FileTransferTipLine fileName={fileName} fileSize={fileSize} />;
}

function ResolvedFileTransferTip({
  input,
  peer,
  fileName,
  fileSize,
}: {
  input: FileTransferTipScope & { tipId: string; tipSeq: number };
  peer: string;
  fileName: string;
  fileSize?: number;
}) {
  const jumpToMessage = useContext(ReplyJumpContext);
  const { data: original } = trpc.account.fileTransferTipOriginal.useQuery(input, {
    staleTime: 30_000,
    retry: false,
    trpc: { abortOnUnmount: true },
  });
  const prefix =
    peer && original?.direction === 'self'
      ? `${peer}接收了你发送的文件`
      : peer && original?.direction === 'peer'
        ? `你接收了${peer}发送的文件`
        : undefined;
  return (
    <FileTransferTipLine
      fileName={fileName}
      fileSize={fileSize}
      prefix={prefix}
      onJump={
        original
          ? () => void jumpToMessage({ msgId: original.msgId, seq: original.msgSeq })
          : undefined
      }
    />
  );
}

function FileTransferTipLine({
  fileName,
  fileSize,
  prefix = '文件传输完成',
  onJump,
}: {
  fileName: string;
  fileSize?: number;
  prefix?: string;
  onJump?: () => void;
}) {
  const size = fileSize ? formatBytes(fileSize) : '';

  return (
    <div className="weq-graytip text-center text-xs py-2">
      <span>{prefix} </span>
      {onJump ? (
        <button
          type="button"
          className="weq-graytip-accent weq-graytip-message-link"
          title="跳转到原文件消息"
          onClick={(event) => {
            event.stopPropagation();
            onJump();
          }}
        >
          {fileName}
        </button>
      ) : (
        <span className="weq-graytip-accent">{fileName}</span>
      )}
      {size ? (
        <span className="px-1">
          (<span className="weq-number weq-number-inherit">{size}</span>)
        </span>
      ) : null}
    </div>
  );
}
