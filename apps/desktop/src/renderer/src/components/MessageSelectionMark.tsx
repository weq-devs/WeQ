import { Check } from 'lucide-react';
import '../styles/message-row-selection.css';

export function MessageSelectionMark({ selected }: { selected: boolean }) {
  return (
    <span className="message-select-mark" aria-hidden>
      {selected ? <Check size={13} strokeWidth={3.2} /> : null}
    </span>
  );
}
