import { getAppContext } from '../context/app_context';
import { resolveOcrChatImageFile } from '../media_protocol';

export async function chatImageFileForTool(target: {
  kind: 'c2c' | 'group';
  conv: string;
  msgId: string;
  imageIndex: number;
}) {
  const { kind, conv, msgId, imageIndex } = target;
  const { services, account } = getAppContext();
  if (!services) throw new Error('账号尚未打开');
  const check = () => {
    const current = getAppContext();
    if (current.services !== services || current.account !== account) throw new Error('账号已切换');
  };
  const row =
    kind === 'group'
      ? await services.msgs.getGroupMessageById(conv, BigInt(msgId))
      : await services.msgs.getC2cMessageById(conv, BigInt(msgId));
  check();
  if (!row || ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) !== conv)
    return { ...target, found: false };
  const pic = row.elements.filter((element) => element.type === 'pic')[imageIndex];
  if (!pic || Number(pic.data.subType) === 1) return { ...target, found: false };
  const { data } = pic;
  const query = new URLSearchParams({
    name: String(data.fileName ?? ''),
    t: String(row.sendTime),
    token: String(data.fileToken ?? ''),
    md5: String(data.md5 ?? ''),
    orig: String(data.originalUrl ?? ''),
  });
  const signal = AbortSignal.timeout(12_000);
  const resolved = await resolveOcrChatImageFile(query, true, check, signal).catch(() => null);
  check();
  if (resolved?.path && resolved.variant !== 'thumb')
    return { ...target, found: true, localPath: resolved.path, variant: 'original' };
  const cached = await services.fileSearch.findFile(
    Number(row.sendTime),
    String(data.fileName ?? ''),
    'pic',
    String(data.md5 ?? '') || undefined,
  );
  check();
  const localPath = cached.source ?? cached.thumb;
  return localPath
    ? { ...target, found: true, localPath, variant: cached.source ? 'original' : 'thumbnail' }
    : { ...target, found: false };
}
