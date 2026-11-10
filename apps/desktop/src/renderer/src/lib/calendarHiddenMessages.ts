import type { CalendarTarget } from '@weq/service/conversation-calendar';

/** 克隆的本地隐藏标记与 ChatPane 使用同一持久身份，不读取消息正文。 */
export async function calendarTargetsWithHiddenMessages(
  targets: CalendarTarget[],
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
  current: () => boolean = () => true,
): Promise<CalendarTarget[]> {
  const result = targets.map((target) => ({ ...target }));
  const owners = new Map<string, CalendarTarget>(
    result.flatMap((target) =>
      target.kind === 'persona' || target.kind === 'cloneGroup'
        ? [[`${target.kind === 'persona' ? 'persona' : 'group'}:${target.conv}`, target] as const]
        : [],
    ),
  );
  if (!owners.size) return result;
  const prefix = 'chat-template.hiddenMessages.virtual:clone:';
  let began = performance.now();
  try {
    for (let index = 0; index < storage.length; index++) {
      if (!current()) return result;
      if (performance.now() - began >= 4) {
        await new Promise<void>((done) => setTimeout(done, 0));
        began = performance.now();
      }
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const tail = key.slice(prefix.length),
        separator = tail.lastIndexOf(':');
      const owner = owners.get(tail.slice(0, separator));
      if (!owner || separator < 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(storage.getItem(key) ?? '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(value)) continue;
      owner.hiddenIds ??= {};
      owner.hiddenIds[tail.slice(separator + 1)] = value.filter(
        (id): id is string => typeof id === 'string',
      );
    }
  } catch {
    /* 与聊天页一致：浏览器存储不可读时视为没有本地隐藏标记。 */
  }
  return result;
}
