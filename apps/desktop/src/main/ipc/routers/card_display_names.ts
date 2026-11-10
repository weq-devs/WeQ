/** 云端名称只投影到名片返回值，不改本地资料及会话缓存。 */
export async function cardDisplayNames<T extends { nick: string; remark: string }>(
  local: T | null,
  readNick: () => Promise<string>,
  readRemark?: () => Promise<string | null>,
): Promise<T | null> {
  if (!local) return null;
  const [nick, remark] = await Promise.allSettled([
    readNick(),
    readRemark ? readRemark() : Promise.resolve(local.remark),
  ]);
  return {
    ...local,
    nick: nick.status === 'fulfilled' ? nick.value : local.nick,
    remark: remark.status === 'fulfilled' ? (remark.value ?? '') : local.remark,
  };
}
