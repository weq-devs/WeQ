import { createContext } from 'react';

export const MessageLayoutContext = createContext<
  ((anchor: HTMLElement, selectors: string[], animateLayout: boolean) => void) | null
>(null);
