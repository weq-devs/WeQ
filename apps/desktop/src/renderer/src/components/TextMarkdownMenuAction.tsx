import { CodeXml, FileText } from 'lucide-react';
import { useContext } from 'react';
import type { Message } from '../im-template/template/types';
import {
  autoTextMarkdownBody,
  TextMarkdownContext,
  textMarkdownBody,
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
  const override = useTextMarkdownStore((state) => state.modes.get(key));
  const elements = message.qqElements ?? [];
  if (textMarkdownBody(elements) === null) return null;
  const rendered = override ?? (enabled && autoTextMarkdownBody(elements) !== null);
  const label = rendered ? '显示原文' : '显示 Markdown';
  return (
    <button
      type="button"
      title={label}
      onClick={() => {
        useTextMarkdownStore.getState().setRendered(key, !rendered);
        onClose?.();
      }}
    >
      {rendered ? <CodeXml size={17} /> : <FileText size={17} />}
      <span>{label}</span>
    </button>
  );
}
