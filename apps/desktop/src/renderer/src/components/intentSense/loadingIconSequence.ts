/** 每轮覆盖全部图标，轮内随机，跨轮避免连续重复。 */
export function createLoadingIconSequence(
  count: number,
  previous?: number,
  random: () => number = Math.random,
): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [order[index], order[target]] = [order[target]!, order[index]!];
  }
  if (order.length > 1 && order[0] === previous) {
    [order[0], order[1]] = [order[1]!, order[0]!];
  }
  return order;
}
