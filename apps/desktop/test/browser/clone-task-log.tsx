import { createRoot } from 'react-dom/client';
import { CloneTaskLog } from '../../src/renderer/src/views/agentlab/CloneTaskLog';
import { appendCloneOutput } from '../../src/renderer/src/views/agentlab/cloneTaskOutput';
import type { CloneTask } from '../../src/renderer/src/views/agentlab/cloneTaskStore';
import '../../src/renderer/src/styles/index.css';
import { accentColors } from '../../src/shared/theme_colors';

Object.assign(window, {
  cloneLogTheme: (theme: string, accent: string, background: string) => {
    const resolved =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme === 'dark'
          ? 'dark'
          : 'light';
    const html = document.documentElement;
    html.dataset.theme = resolved;
    html.dataset.background = background;
    html.style.setProperty('--weq-accent-effective', accent);
    html.style.setProperty('--weq-accent-on', accentColors(accent, resolved).onAccent);
  },
});

let outputs: NonNullable<CloneTask['outputs']> = [];
for (let index = 0; index < 7; index++) {
  outputs = appendCloneOutput(outputs, {
    requestId: String(index),
    feature:
      index < 4
        ? ['画像卡', '对话样本', '表达风格库', '备用表达风格'][index]!
        : `深层画像 ${index - 3}/12`,
    model: 'synthetic-model',
    status: index === 1 ? 'failed' : 'running',
    channel: 'content',
    text: `${index + 1} 号请求的合成输出\n${'很长的合成模型输出abcdefghij'.repeat(50)}`,
    error: index === 1 ? '合成模型请求超时' : undefined,
  });
  outputs = appendCloneOutput(outputs, {
    requestId: String(index),
    feature: outputs[index]!.feature,
    model: 'synthetic-model',
    status: index === 1 ? 'failed' : 'running',
    channel: 'reasoning',
    text: '合成推理片段',
  });
}
const task = { personaId: 'fixture', outputs } as CloneTask;
createRoot(document.getElementById('root')!).render(
  <main
    style={{
      maxWidth: 760,
      margin: '0 auto',
      padding: 16,
      minHeight: '100vh',
      background: 'var(--weq-chat-bg)',
      boxSizing: 'border-box',
    }}
  >
    <CloneTaskLog task={task} />
  </main>,
);
