import { createRoot } from 'react-dom/client';
import { CloneTaskLog } from '../../src/renderer/src/views/agentlab/CloneTaskLog';
import { TaskLogConsole, type TaskLogLine } from '../../src/renderer/src/components/TaskLogConsole';
import { TaskLogDisclosure } from '../../src/renderer/src/components/TaskLogDisclosure';
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
const lines: TaskLogLine[] = Array.from({ length: 20 }, (_, seq) => ({
  ts: 0,
  seq,
  stage: 'task',
  level: seq % 3 === 0 ? 'error' : seq % 3 === 1 ? 'warn' : 'info',
  text: `合成任务记录 ${seq}：${'日志内容'.repeat(12)}`,
}));
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
    <h3>导出日志</h3>
    <TaskLogConsole lines={lines} collapsed={false} appearance="export" />
    <h3>请求日志</h3>
    <TaskLogConsole lines={lines} collapsed={false} scrollable autoFollow={false} />
    <TaskLogDisclosure open onOpenChange={() => {}} lines={lines} />
    <TaskLogConsole lines={[]} collapsed={false} />
    {/* 仅验证日志文件查看器的内容区样式，不读取实际日志文件。 */}
    <h3>文件日志</h3>
    <div className="weq-help-log-view">
      {lines.map((line) => (
        <div key={line.seq} className={`weq-log-line is-${line.level}`}>
          <span className="weq-log-ts">08:00:00.000</span>
          <span className="weq-log-lv">{line.level.toUpperCase()}</span>
          <span className="weq-log-msg">{line.text}</span>
        </div>
      ))}
    </div>
  </main>,
);
