import { getAppContext, type AccountServices } from '../context/app_context';
import { handleMediaRequest } from '../media_protocol';
import { createMcpDownloadRoute } from './media_download';

export const MCP_CHAT_VIDEO_ROUTE = '/chat/videos/';
const route = createMcpDownloadRoute(MCP_CHAT_VIDEO_ROUTE, '视频', 'video.mp4');
export const handleMcpChatVideoDownload = route.handle;

export async function chatVideoForTool(
  account: AccountServices,
  {
    kind,
    conv,
    msgId,
    videoIndex,
  }: {
    kind: 'c2c' | 'group';
    conv: string;
    msgId: string;
    videoIndex: number;
  },
) {
  const row =
    kind === 'group'
      ? await account.msgs.getGroupMessageById(conv, BigInt(msgId))
      : await account.msgs.getC2cMessageById(conv, BigInt(msgId));
  if (getAppContext().services !== account) throw new Error('账号或数据源已切换，请重新查询。');
  if (!row || ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) !== conv)
    throw new Error('指定会话中没有这条消息。');
  const el = row.elements.filter((el) => el.type === 'video')[videoIndex];
  if (!el) throw new Error('指定消息中没有这个视频。');
  const { fileName: name, fileToken: token, fileSize: size } = el.data;
  if (!name && !token) throw new Error('该消息没有可用的视频原片标识。');
  const query = new URLSearchParams({
    t: String(Number(row.sendTime) * 1000),
    name,
    token,
    msgId,
    conv: kind === 'group' ? conv : '',
    intent: 'interactive',
  });
  return route.issue(account, name, size, (signal, check) =>
    handleMediaRequest(new Request(`weq-media://video?${query}`, { signal }), check, {
      cacheVideo: false,
    }),
  );
}
