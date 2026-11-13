import { createContext } from 'react';

export { TextMarkdownContext } from './textMarkdown';
export const LinkPreviewContext = createContext(true);
export const MsgDecorationEnabledContext = createContext({
  bubble: true,
  font: true,
  widget: true,
});
