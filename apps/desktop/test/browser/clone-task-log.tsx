import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelRequestLog } from '../../src/renderer/src/components/ModelRequestLog';
import { suggestionLogBlocks } from '../../src/renderer/src/lib/modelRequestLog';
import { CloneTaskLog } from '../../src/renderer/src/views/agentlab/CloneTaskLog';
import { LongTaskRow } from '../../src/renderer/src/components/tasks/LongTaskRow';
import { TaskList } from '../../src/renderer/src/views/export/TaskList';
import { TaskLogConsole, type TaskLogLine } from '../../src/renderer/src/components/TaskLogConsole';
import { TaskLogDisclosure } from '../../src/renderer/src/components/TaskLogDisclosure';
import { appendCloneOutput } from '../../src/renderer/src/views/agentlab/cloneTaskOutput';
import type { CloneTask } from '../../src/renderer/src/views/agentlab/cloneTaskStore';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';
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

const modelText = JSON.stringify({
  summary: '确认时间与安排',
  replies: [
    { text: '有空，明天下午见。', tone: '自然' },
    { text: '合成很长的推荐内容'.repeat(35), tone: '轻松' },
  ],
});
function SuggestionLogFixture() {
  const [running, setRunning] = useState(false);
  const [text, setText] = useState(modelText);
  const logs: TaskLogLine[] = [
    {
      seq: 1,
      ts: 1000,
      stage: 'System Prompt',
      text: 'System Prompt\n合成系统提示词',
      level: 'info',
    },
    {
      seq: 2,
      ts: 1001,
      stage: 'User Prompt',
      text: 'User Prompt\n' + JSON.stringify({ messages: [{ text: '明天有空吗？' }] }),
      level: 'info',
    },
    { seq: 3, ts: 1002, stage: '推理输出', text: '合成推理片段', level: 'info' },
    { seq: 4, ts: 1003, stage: '模型正文', text, level: 'info' },
    ...(!running
      ? [
          {
            seq: 5,
            ts: 1004,
            stage: '响应汇总',
            text: JSON.stringify({ choices: [{ message: { content: text } }] }),
            level: 'info' as const,
          },
        ]
      : []),
  ];
  return (
    <section data-suggestion-log>
      <h3>推荐回复日志</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => {
            setRunning(true);
            setText('{"summary":');
          }}
        >
          模拟开始
        </button>
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => setText((previous) => previous + '"正在接收"')}
        >
          模拟片段
        </button>
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => {
            setRunning(true);
            setText('合成流式长输出\n'.repeat(160));
          }}
        >
          模拟长输出
        </button>
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => {
            setText(modelText);
            setRunning(false);
          }}
        >
          模拟完成
        </button>
      </div>
      <ModelRequestLog blocks={suggestionLogBlocks(logs)} running={running} />
    </section>
  );
}
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
    <TaskList
      tasks={[
        {
          id: 'finalizing',
          name: '合成导出收尾',
          kind: 'c2c',
          format: 'json',
          status: 'paused',
          progress: 50,
          current: 50,
          total: 100,
          canResume: true,
          canFinalize: true,
          isFinalizing: true,
        },
      ]}
      detailOnly
      onPause={() => {}}
      onResume={() => {}}
      onCancel={() => {}}
      onDownload={() => {}}
      onDelete={() => {}}
      onShowFailures={() => {}}
      onFinalize={() => {}}
    />
    <LongTaskRow
      active
      onSelect={() => {}}
      task={{
        id: 'preparing',
        name: '合成克隆',
        kind: '好友克隆',
        status: 'running',
        progress: 28,
        note: '整理语料 12/100 · 正在请求视觉模型返回',
        icon: null,
        detail: null,
      }}
    />
    <CloneTaskLog task={{ personaId: 'preparing', status: 'running' } as CloneTask} />
    <CloneTaskLog task={task} />
    <SuggestionLogFixture />
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
