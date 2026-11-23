import { createContext } from 'react';

export const MessageLayoutContext = createContext<
  ((anchor: HTMLElement, selectors: string[]) => void) | null
>(null);
