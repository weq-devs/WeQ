export function dressIdQuery(keyword: string): string | undefined {
  return /^#?(\d+)$/.exec(keyword.trim())?.[1];
}

export function dressPreviewUrl(kind: 'bubble' | 'font' | 'widget', itemId: number): string {
  const category = kind === 'widget' ? 'faceAddon' : kind;
  return `https://tianquan.gtimg.cn/${category}/item/${itemId}/newPreview1.png`;
}
