export function profileLikeSummary(shown: number, total: string | null | undefined) {
  if (total === null || total === undefined) return shown ? `已显示 ${shown} 人` : '';
  return total === '0' ? '还没有人赞过' : `${total} 人赞过`;
}
