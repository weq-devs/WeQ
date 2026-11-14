import superjson from 'superjson';

export const HTTP_BATCH_MAX_URL_LENGTH = 2048;

/** tRPC 单次查询内的数组不会自动拆分，按实际编码长度和接口上限分批。 */
export function queryInputBatches<T, Target>(
  procedure: string,
  targets: readonly Target[],
  input: (targets: Target[]) => T,
  web: boolean,
  limit: number,
): T[] {
  const batches: T[] = [];
  const fits = (targets: Target[]) => {
    if (targets.length > limit) return false;
    if (!web) return true;
    const encoded = encodeURIComponent(JSON.stringify({ 0: superjson.serialize(input(targets)) }));
    return `/trpc/${procedure}?batch=1&input=`.length + encoded.length <= HTTP_BATCH_MAX_URL_LENGTH;
  };
  let batch: Target[] = [];
  for (const target of targets) {
    const next = [...batch, target];
    if (fits(next)) {
      batch = next;
      continue;
    }
    if (batch.length) batches.push(input(batch));
    batch = [target];
    if (!fits(batch)) throw new Error('查询的单个会话参数超过传输长度上限');
  }
  if (batch.length) batches.push(input(batch));
  return batches;
}
