import { createContext } from 'react';

export { TextMarkdownContext } from './textMarkdown';
export const DEFAULT_LINK_PREVIEW_DISPLAY = { enabled: true, autoFetch: false };
const linkPreviewContext = createContext(DEFAULT_LINK_PREVIEW_DISPLAY);
export { linkPreviewContext as LinkPreviewContext };
export const MsgDecorationEnabledContext = createContext({
  bubble: true,
  font: true,
  widget: true,
});
