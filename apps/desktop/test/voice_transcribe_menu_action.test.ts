import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceTranscribeMenuAction } from '../src/renderer/src/components/VoiceTranscribeMenuAction';
import { createTemplateDemoData } from './support/templateDemoData';

const voice = vi.hoisted(() => ({
  run: vi.fn(),
  hook: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: (input: unknown) => {
    voice.hook(input);
    return { available: true, busy: false, run: voice.run };
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('多语音消息只转写右键命中的语音，不误用第一段已转写内容', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const message = {
    ...createTemplateDemoData().messages[0]!,
    qqElements: [
      {
        type: 'ptt',
        data: { fileName: 'first.amr', fileToken: 'first', pttTranscript: '已有转写' },
      },
      { type: 'ptt', data: { fileName: 'second.amr', fileToken: 'second' } },
    ],
  };
  try {
    await act(async () =>
      root.render(
        createElement(VoiceTranscribeMenuAction, {
          message,
          onClose: close,
          target: { name: 'second.amr', token: 'second' },
        }),
      ),
    );
    expect(voice.hook).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'second.amr', token: 'second' }),
    );
    expect(host.querySelector('svg')?.classList.contains('lucide-captions')).toBe(true);
    act(() => host.querySelector('button')!.click());
    expect(voice.run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        createElement(VoiceTranscribeMenuAction, {
          message,
          target: { name: 'second.amr', token: 'missing' },
        }),
      ),
    );
    expect(host.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
