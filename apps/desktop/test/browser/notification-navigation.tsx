import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import { useToast } from '../../src/renderer/src/components/Toast.shared';
import {
  notificationSource,
  onNotificationNavigation,
} from '../../src/renderer/src/lib/notificationNavigation.shared';
import type { NotificationTarget } from '../../src/renderer/src/lib/notificationNavigation';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mail.css';

const routes: NotificationTarget[] = [];
let plays = 0;
let updateView: (text: string) => void = () => {};
onNotificationNavigation((target) => {
  routes.push(target);
  updateView(JSON.stringify(target));
});
function View() {
  const [text, setText] = useState('消息');
  updateView = setText;
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>通知来源</h1>
      <output id="destination">{text}</output>
      <div className="weq-mail-retained" hidden={routes.at(-1)?.kind !== 'mail'} />
      <ToastHost />
    </main>
  );
}
const reset = (mail = false) => {
  routes.length = 0;
  plays = 0;
  updateView('消息');
  useToast.setState({ toasts: [], leaving: [] });
  useToast.getState().setDurations({ successSeconds: -1, failureSeconds: -1 });
  useToast.getState().push({
    tone: 'error',
    title: '这条消息发送失败，请返回原来的群聊检查并保留当前输入内容',
    detail: '合成错误详情，展开、复制与关闭都不应触发导航。',
    source: notificationSource(
      mail
        ? { kind: 'mail', folderId: 1, mailId: 'fixture-mail' }
        : {
            kind: 'conversation',
            conversationKind: 'group',
            conv: 'fixture-group',
            msgId: 'fixture-message',
          },
      mail ? '打开这封邮件' : undefined,
    ),
  });
  useToast.getState().push({
    title: '任务尚未完成',
    source: notificationSource({ kind: 'task', id: 'export:fixture' }),
    action: {
      label: '播放样例语音',
      icon: 'play',
      keepOpen: true,
      run: () => {
        plays++;
      },
    },
  });
  useToast.getState().push({ tone: 'success', title: '已复制' });
};
Object.assign(window, {
  notificationQa: { reset, routes, plays: () => plays, theme: useThemeStore },
});
reset();
createRoot(document.getElementById('root')!).render(<View />);
