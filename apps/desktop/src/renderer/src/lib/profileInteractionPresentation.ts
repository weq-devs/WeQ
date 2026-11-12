export function profileLikeSummary(names: string[], total: string | null | undefined) {
  const shown = names.slice(0, 3).join('、');
  if (!shown) return total === null || total === undefined ? '' : `${total} 人觉得很赞`;
  if (total === '1') return `${shown}觉得很赞`;
  return `${shown}等${total === null || total === undefined ? '人' : ` ${total} 人`}觉得很赞`;
}
