import { createRoot } from 'react-dom/client';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { qqMessageRenderer } from '../../src/renderer/src/components/QqMessageContent';
import { createTemplateDemoData } from '../support/templateDemoData';
import type { Message } from '../../src/renderer/src/im-template/template/types';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import { useViewState } from '../../src/renderer/src/state/view';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import { favoriteRequests, favoriteInvalidations } from './favorite-emoji.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const demo = createTemplateDemoData();
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const user = { ...demo.user, avatarUrl: avatar };
const conversation = {
  ...demo.conversations.find((row) => row.type === 'direct')!,
  otherUser: { ...user, id: 'peer', avatarUrl: avatar },
};
const pic = (name: string, subType = 1) => ({
  type: 'pic',
  data: { fileName: name, fileToken: name, imgWidth: 100, imgHeight: 100, subType },
});
const messages: Message[] = [
  ['custom', [pic('custom.gif')]],
  ['multiple', [pic('first.png', 0), pic('second.gif')]],
  ['market', [{ type: 'mface', data: { emojiPackId: 123, marketEmoticonIdHex: 'a'.repeat(32) } }]],
  ['system', [{ type: 'face', data: { faceId: 14 } }]],
].map(([id, qqElements], index) => ({
  id: String(id),
  conversationId: conversation.id,
  senderId: 'peer',
  body: '[表情]',
  createdAt: new Date(1794355200000 + index * 1000).toISOString(),
  msgSeq: String(index + 1),
  qqElements: qqElements as Message['qqElements'],
}));
useViewState.setState({ openedUin: '10001' });
declare global {
  interface Window {
    favoriteFixture: (theme: ThemePreference, accent: string, background: ThemeBackground) => void;
    favoriteRequests: typeof favoriteRequests;
    favoriteInvalidations: typeof favoriteInvalidations;
  }
}
window.favoriteRequests = favoriteRequests;
window.favoriteInvalidations = favoriteInvalidations;
window.favoriteFixture = (theme, accent, background) => {
  const store = useThemeStore.getState();
  store.setPreference(theme);
  store.setAccent(accent);
  store.setBackground(background);
};
createRoot(document.getElementById('root')!).render(
  <>
    <ChatPane
      user={user}
      conversation={conversation}
      messages={messages}
      messageRenderers={[qqMessageRenderer]}
      draft=""
      onSend={() => {}}
      onBack={() => {}}
      onForwardMessages={() => {}}
      onAddToComposition={() => {}}
      onDeleteMessage={() => {}}
      sendAvailable
    />
    <ToastHost />
  </>,
);
