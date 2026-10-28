import { CodeXml, FileText } from 'lucide-react';
import { useContext } from 'react';
import type { Message } from '../im-template/template/types';
import {
  autoTextMarkdownBody,
  TextMarkdownContext,
  textMarkdownKey,
  useTextMarkdownStore,
} from '../state/textMarkdown';

export function TextMarkdownMenuAction({
  message,
  onClose,
}: {
  message: Message;
  onClose?: () => void;
}) {
  const enabled = useContext(TextMarkdownContext);
  const key = textMarkdownKey(message);
  const raw = useTextMarkdownStore((state) => state.rawKeys.has(key));
  if (!enabled || autoTextMarkdownBody(message.qqElements ?? []) === null) return null;
  const label = raw ? '显示 Markdown' : '显示原文';
  return (
    <button
      type="button"
      title={label}
      onClick={() => {
        useTextMarkdownStore.getState().toggle(key);
        onClose?.();
      }}
    >
      {raw ? <FileText size={17} /> : <CodeXml size={17} />}
      <span>{label}</span>
    </button>
  );
}
