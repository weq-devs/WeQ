type ObjectUrlUse = { count: number; releaseRequested: boolean };
const uses = new Map<string, ObjectUrlUse>();

/** 灯箱等临时消费者借用附件地址，附件交接结束也不能提前撤销它。 */
export function retainObjectUrl(url: string): () => void {
  if (!url.startsWith('blob:')) return () => {};
  const use = uses.get(url) ?? { count: 0, releaseRequested: false };
  uses.set(url, use);
  use.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--use.count > 0) return;
    uses.delete(url);
    if (use.releaseRequested) URL.revokeObjectURL(url);
  };
}

/** 原持有者放弃地址；有预览仍在使用时，等最后一个消费者退出再释放。 */
export function releaseObjectUrl(url: string): void {
  const use = uses.get(url);
  if (use) use.releaseRequested = true;
  else URL.revokeObjectURL(url);
}
