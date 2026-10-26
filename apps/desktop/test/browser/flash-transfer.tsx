import { createRoot } from 'react-dom/client';
import { FlashTransferViewer } from '../../src/renderer/src/components/FlashTransferViewer';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

declare global {
  interface Window {
    flashFixture: (theme: ThemePreference, accent: string, background: ThemeBackground) => void;
  }
}
window.flashFixture = (theme, accent, background) => {
  const store = useThemeStore.getState();
  store.setAccent(accent);
  store.setBackground(background);
  store.setPreference(theme);
};
createRoot(document.getElementById('root')!).render(
  <>
    <style>{'body{margin:0;min-height:100vh;background:var(--weq-chat-bg)}'}</style>
    <FlashTransferViewer filesetId="fixture" title="课程资料与项目附件" onClose={() => {}} />
  </>,
);
