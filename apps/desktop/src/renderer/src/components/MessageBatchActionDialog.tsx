import { useId, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { Modal } from './Dialog';
import { GapMessagesModal } from './compose/GapMessagesModal';
import type { Conversation, Message, User } from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import type { MessageBatchAction, partitionMessageBatch } from '../lib/messageBatchAction';
import '../styles/message-batch-action.css';

export function MessageBatchActionDialog({
  action,
  batch,
  conversation,
  user,
  renderers,
  onContinue,
  onClose,
}: {
  action: MessageBatchAction;
  batch: ReturnType<typeof partitionMessageBatch>;
  conversation: Conversation;
  user: User;
  renderers?: MessageRenderer[];
  onContinue: (messages: Message[]) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [preview, setPreview] = useState(false);
  const reasons = new Map(batch.unsupported.map(({ message, reason }) => [message.id, reason]));
  const label = { export: '导出', analysis: '分析', delete: '删除', recall: '撤回' }[action];
  return (
    <Modal
      width={560}
      centered
      labelledBy={preview ? 'weq-gap-messages-title' : id}
      onClose={onClose}
      dismissOnOutside={false}
      className="weq-message-batch-dialog"
    >
      {preview ? (
        <div>
          <GapMessagesModal
            embedded
            preview
            title={`不支持${label}的消息`}
            backLabel="返回操作确认"
            conversation={conversation}
            user={user}
            messages={batch.unsupported.map((item) => item.message)}
            renderers={renderers}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            moreFailed={false}
            totalCount={batch.unsupported.length}
            messageNotice={(message) => reasons.get(message.id)}
            onLoadMore={() => {}}
            onClose={() => setPreview(false)}
          />
        </div>
      ) : (
        <div className="weq-dialog">
          <div className="weq-dialog-head">
            <h3 id={id} className="weq-dialog-title">
              部分消息无法{label}
            </h3>
            <button
              type="button"
              className="weq-dialog-x"
              title="关闭"
              aria-label="关闭操作确认"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          <div className="weq-dialog-body">
            <p>
              {batch.unsupported.length} 条消息不支持{label}，{batch.supported.length} 条可以继续。
            </p>
            <button type="button" className="weq-action-soft" onClick={() => setPreview(true)}>
              <Eye size={15} />
              预览不支持的消息
            </button>
          </div>
        </div>
      )}
      <footer className="weq-dialog-foot">
        <button type="button" className="weq-action-soft" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="weq-action-primary"
          disabled={!batch.supported.length}
          onClick={() => onContinue(batch.supported)}
        >
          仅{label}支持的 {batch.supported.length} 条
        </button>
      </footer>
    </Modal>
  );
}
