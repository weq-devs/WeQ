import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { DEFAULT_TOAST_DURATIONS } from '@weq/service/toast-settings';
import { useToast } from '../src/renderer/src/components/Toast';

const cases = [
  ['components/ImageLightbox.tsx', '没识别到文字'],
  ['components/UdpCapturePanel.tsx', '没有可导出的数据报'],
  ['components/settings/McpServerSection.tsx', '没有可安装的客户端'],
  ['components/settings/GlobalSettingsSection.tsx', '已安排清除剩余项目'],
  ['components/settings/AgentLabSection.tsx', '请先填写 Base URL。'],
  ['components/settings/AgentLabSection.tsx', '请先添加并填写一个带「聊天」能力的模型。'],
  ['components/settings/VoiceTranscribeSection.tsx', '请先填写服务地址（Base URL）。'],
  ['components/settings/SsePushSection.tsx', '请先填写推送地址。'],
  ['components/settings/ExternalRkeySection.tsx', '请先填写服务器地址与 access_token。'],
  ['components/compose/RecalledMessagesModal.tsx', '未找到该消息'],
  ['components/mergeForward/MergeForwardDialog.tsx', '先选择会话'],
  ['views/annual-report/QzoneShareLightbox.tsx', '上一次分享还没发完'],
  ['im-template/template/chatPane.tsx', 'SVG 按文件发送'],
  ['im-template/template/chatPane.tsx', '请先补全或取消所选消息缺口'],
  ['im-template/template/chatPane.tsx', '闪照只能发送图片'],
  ['im-template/template/chatPane.tsx', '泡泡消息只能发送视频'],
  ['views/MainView.tsx', '未找到该条消息'],
  ['views/MainView.tsx', '未找到该消息位置'],
  ['views/MainView.tsx', '请撤销最近一次标记'],
  ['views/MainView.tsx', '没有选中的会话'],
  ['views/MainView.tsx', 'AI 声聊只支持群聊'],
  ['views/MainView.tsx', '群临时会话暂不支持发文件'],
  ['views/MainView.tsx', '请选择不超过 4096 个真实聊天会话'],
  ['views/MainView.tsx', '请先切回转发时的账号再打开对话'],
] as const;

it.each(cases)('%s：%s 保留视觉样式并跟随成功时长', (file, text) => {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve('src/renderer/src', file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === text,
      )
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(matches.length).toBeGreaterThan(0);
  const store = useToast.getState();
  try {
    for (const match of matches) {
      const literals = Object.fromEntries(
        match.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
            ? [[property.name.getText(source), property.initializer.text]]
            : [],
        ),
      );
      expect(literals.durationKind).toBe('success');
      expect(['info', 'warning']).toContain(literals.tone);
      const tone = literals.tone === 'warning' ? 'warning' : 'info';
      store.setDurations({ ...DEFAULT_TOAST_DURATIONS });
      const id = store.push({ tone, durationKind: 'success', title: text });
      expect(useToast.getState().toasts.find((toast) => toast.id === id)?.ttl).toBe(
        DEFAULT_TOAST_DURATIONS.successSeconds * 1000,
      );
      store.setDurations({ successSeconds: 7, failureSeconds: -1 });
      expect(useToast.getState().toasts.find((toast) => toast.id === id)?.ttl).toBe(7000);
    }
  } finally {
    useToast.setState({ toasts: [], leaving: [], durations: { ...DEFAULT_TOAST_DURATIONS } });
  }
});
