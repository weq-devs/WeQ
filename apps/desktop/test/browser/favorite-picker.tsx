import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { EmojiPanel } from '../../src/renderer/src/im-template/template/emojiPanel';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useViewState } from '../../src/renderer/src/state/view';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/im-template/styles.css';

useViewState.setState({ openedUin: '10001' });
Object.assign(window, {
  favoritePickerTheme: (dark: boolean, accent: string, background: string) => {
    useThemeStore.getState().setPreference(dark ? 'dark' : 'light');
    useThemeStore.getState().setAccent(accent);
    document.documentElement.dataset.background = background;
  },
});
function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <main className="im-template">
      <div
        style={{ position: 'relative', height: '90dvh', width: '100%', transform: 'translateZ(0)' }}
      >
        <EmojiPanel panelRef={ref} onSelect={() => {}} />
        <style>{`.emoji-panel { bottom: 20px; }`}</style>
      </div>
      <DialogHost />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
