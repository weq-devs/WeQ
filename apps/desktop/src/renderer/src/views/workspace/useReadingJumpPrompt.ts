import type { ChatJumpMode } from '@weq/service/client-preferences';
import { useState } from 'react';

type Entry = { conversation: string; target?: string; mode: ChatJumpMode };

export function useReadingJumpPrompt(scope: string, entry: Entry) {
  const [state, setState] = useState<{
    scope: string;
    entry: Entry;
    dismissed: Map<string, string>;
  }>();
  const current = state?.scope === scope ? state : undefined;
  const previous = current?.entry;
  if (
    previous?.conversation !== entry.conversation ||
    previous?.mode !== entry.mode ||
    previous?.target !== entry.target
  ) {
    const dismissed = new Map(current?.dismissed);
    if (
      previous?.conversation !== entry.conversation &&
      previous?.mode === 'entry' &&
      previous.target
    )
      remember(dismissed, previous.conversation, previous.target);
    setState({ scope, entry, dismissed });
  }
  return {
    show: Boolean(
      entry.target &&
        entry.mode !== 'off' &&
        current?.dismissed.get(entry.conversation) !== entry.target,
    ),
    dismiss: () => {
      if (!entry.target) return;
      const { conversation, target } = entry;
      setState((latest) => {
        if (latest?.scope !== scope || latest.entry.conversation !== conversation) return latest;
        const dismissed = new Map(latest.dismissed);
        remember(dismissed, conversation, target);
        return { ...latest, dismissed };
      });
    },
  };
}

function remember(dismissed: Map<string, string>, conversation: string, target: string) {
  dismissed.delete(conversation);
  dismissed.set(conversation, target);
  if (dismissed.size > 512) dismissed.delete(dismissed.keys().next().value!);
}
