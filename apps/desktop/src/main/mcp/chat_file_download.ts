import type { AccountServices } from '../context/app_context';
import { planFileMedia } from '../media_save';
import { handleMediaRequest } from '../media_protocol';
import { createMcpDownloadRoute } from './media_download';

export const MCP_FILE_ROUTE = '/files/';
const route = createMcpDownloadRoute(MCP_FILE_ROUTE, '文件', 'attachment');
export const handleMcpFileDownload = route.handle;

interface MessageTarget {
  kind: 'c2c' | 'group';
  conv: string;
  msgId: string;
}

export async function readMcpMessage(
  account: AccountServices,
  { kind, conv, msgId }: MessageTarget,
) {
  const row =
    kind === 'group'
      ? await account.msgs.getGroupMessageById(conv, BigInt(msgId))
      : await account.msgs.getC2cMessageById(conv, BigInt(msgId));
  return row && ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) === conv
    ? row
    : null;
}

export async function groupFileForTool(
  account: AccountServices,
  check: () => void,
  { groupCode, folderId, fileId }: { groupCode: string; folderId: string; fileId: string },
) {
  const file = await account.groupFile.findFileInDirectory(
    Number(groupCode),
    folderId,
    fileId,
    check,
  );
  check();
  if (!file) throw new Error('该群目录中没有指定文件，请重新读取目录。');
  return route.issue(account, file.fileName, file.fileSize, async (signal, check) => {
    const plan = await planFileMedia(
      account,
      { kind: 'group-file', groupCode, fileId, fileName: file.fileName, busId: file.busId },
      check,
    );
    return plan.open(signal);
  });
}

export async function chatFileForTool(
  account: AccountServices,
  check: () => void,
  { fileIndex, ...target }: MessageTarget & { fileIndex: number },
) {
  const row = await readMcpMessage(account, target);
  check();
  if (!row) throw new Error('指定会话中没有这条消息。');
  const files = row.elements.filter((element) => element.type === 'file');
  const file = files[fileIndex]?.data;
  if (!file || (!file.fileName && !file.fileToken)) throw new Error('指定消息中没有这个附件。');
  const name = file.fileName;
  const token = file.fileToken;
  if (!token && files.filter(({ data }) => data.fileName === name).length > 1)
    throw new Error('这条消息包含无法区分的同名附件。');
  return route.issue(account, name, file.fileSize, async (signal, check) => {
    const select = async () => {
      const raw = await account.msgs.getRawElements(BigInt(target.msgId));
      check();
      const element = raw?.elements.filter((element) => element.kind === 'file')[fileIndex];
      if (
        raw?.kind !== target.kind ||
        !element ||
        element.fileName !== name ||
        element.fileToken !== token
      )
        throw new Error('附件内容已变化，请重新查询。');
      return { element, conv: target.kind };
    };
    const current = await readMcpMessage(account, target);
    check();
    if (!current) throw new Error('指定会话中没有这条消息。');
    const plan = await planFileMedia(
      account,
      { kind: 'chat-file', msgId: target.msgId, conv: target.conv, name, token },
      check,
      select,
    );
    return plan.open(signal);
  });
}

export async function chatVoiceForTool(
  account: AccountServices,
  check: () => void,
  { voiceIndex, ...target }: MessageTarget & { voiceIndex: number },
) {
  const row = await readMcpMessage(account, target);
  check();
  if (!row) throw new Error('指定会话中没有这条消息。');
  const voice = row.elements.filter((element) => element.type === 'ptt')[voiceIndex]?.data;
  if (!voice || (!voice.fileName && !voice.fileToken)) throw new Error('指定消息中没有这段语音。');
  const query = new URLSearchParams({
    t: String(Number(row.sendTime) * 1000),
    name: voice.fileName,
    token: voice.fileToken,
    msgId: target.msgId,
    conv: target.kind === 'group' ? target.conv : '',
  });
  const fileName = `${voice.fileName.replace(/\.[^.]+$/, '') || 'voice'}.wav`;
  return route.issue(account, fileName, undefined, (signal, check) =>
    handleMediaRequest(new Request(`weq-media://ptt?${query}`, { signal }), check),
  );
}
