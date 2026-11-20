import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

export const voiceModeContext = createContext<{
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  returnId: string | null;
  setReturnId: Dispatch<SetStateAction<string | null>>;
  takeTranscriptDraft: (conversationId: string) => string | undefined;
} | null>(null);

export function useVoiceMode() {
  return useContext(voiceModeContext);
}
