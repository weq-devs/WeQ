import { Search, X } from 'lucide-react';

export function ChatRecordsHeader({
  conversationName,
  title = '聊天记录',
  onClose,
}: {
  conversationName?: string;
  title?: string;
  onClose: () => void;
}) {
  return (
    <div className="weq-chatrecords-head" data-window-drag-handle>
      <div className="weq-chatrecords-title-wrap">
        <h3 id="weq-chatrecords-title" className="weq-search-more-title">
          {title}
        </h3>
        {conversationName ? (
          <span className="weq-chatrecords-fixed-conv" title={conversationName}>
            <Search size={13} aria-hidden />
            {conversationName}
          </span>
        ) : null}
      </div>
      <button type="button" className="weq-dialog-x" onClick={onClose} aria-label="关闭">
        <X size={16} strokeWidth={1.9} aria-hidden />
      </button>
    </div>
  );
}
