import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoicePanel, VoiceWorkspace } from '../src/renderer/src/im-template/template/voicePanel';
import {
  acceptPreferences,
  preferenceValue,
  settlePreferenceWrites,
} from '../src/renderer/src/lib/clientPreferences';

const state = vi.hoisted(() => ({
  revision: 0,
  values: {} as Record<string, unknown>,
  voices: ['a', 'b'],
}));
vi.mock('../src/renderer/src/components/qq-actions/shared.shared', () => ({
  useQQAction: () => ({ binding: {}, available: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    clientState: {
      patch: {
        mutate: async (patch: Record<string, unknown>) => {
          state.values = { ...state.values, ...patch };
          return {
            epoch: 'voice-test',
            revision: ++state.revision,
            values: state.values,
            records: {},
          };
        },
      },
    },
  },
  trpc: {
    account: {
      qqActions: {
        aiVoiceCatalog: {
          useQuery: () => ({
            data: [
              {
                category: '合成目录',
                voices: state.voices.map((id) => ({
                  voiceId: id,
                  voiceDisplayName: id,
                  voiceExampleUrl: '',
                })),
              },
            ],
          }),
        },
      },
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.values = {};
  state.voices = ['a', 'b'];
  acceptPreferences({ epoch: 'voice-test', revision: ++state.revision, values: {}, records: {} });
});
afterEach(() => vi.unstubAllGlobals());

it('语音页签、服务商与各自音色重开后恢复，目录暂缺不改写原选择', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const providers = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
  ];
  const send = vi.fn();
  const props = {
    conversationId: 'fixture',
    conversationLabel: '合成会话',
    canSend: true,
    sendHint: '',
    onSendVoice: send,
    onSendTranscript: send,
    onSendTts: send,
    onSendAiVoice: send,
    text: '',
    onTextChange: vi.fn(),
    onUseTranscriptDraft: vi.fn(),
    onExitVoiceMode: vi.fn(),
  };
  const render = async (available = providers, groupId: number | undefined = 1) => {
    await act(async () =>
      root.render(
        h(VoiceWorkspace, null, h(VoicePanel, { ...props, groupId, ttsProviders: available })),
      ),
    );
  };
  const clickMode = async (name: string) => {
    const button = [
      ...host.querySelectorAll<HTMLButtonElement>('[aria-label="语音方式"] button'),
    ].find((item) => item.textContent?.trim() === name)!;
    await act(async () => button.click());
  };
  const setVoice = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('.voice-tts input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  try {
    await render();
    await clickMode('TTS');
    await setVoice('warm');
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>('.voice-tts input')!.value).toBe('');
    await setVoice('clear');
    await act(async () => root.render(null));
    await render();
    expect(host.querySelector('select')!.value).toBe('b');
    expect(host.querySelector<HTMLInputElement>('.voice-tts input')!.value).toBe('clear');
    await render([providers[0]!]);
    expect(host.querySelector<HTMLInputElement>('.voice-tts input')!.value).toBe('warm');
    expect(preferenceValue('ttsProviderId')).toBe('b');
    await render();
    expect(host.querySelector<HTMLInputElement>('.voice-tts input')!.value).toBe('clear');
    await clickMode('AI 声聊');
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click());
    await clickMode('TTS');
    await clickMode('AI 声聊');
    expect(host.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('b');
    state.voices = ['a'];
    await render();
    expect(host.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('a');
    expect(preferenceValue('aiVoiceId')).toBe('b');
    state.voices = ['a', 'b'];
    await render();
    expect(host.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('b');
    expect(send).not.toHaveBeenCalled();
    await settlePreferenceWrites();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
