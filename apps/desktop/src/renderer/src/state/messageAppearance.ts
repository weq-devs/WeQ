import { createContext } from 'react';

export { TextMarkdownContext } from './textMarkdown';
export const DEFAULT_LINK_PREVIEW_DISPLAY = { enabled: true, autoFetch: false };
export const LinkPreviewContext = createContext(DEFAULT_LINK_PREVIEW_DISPLAY);
export const MsgDecorationEnabledContext = createContext({
  bubble: true,
  font: true,
  widget: true,
});
