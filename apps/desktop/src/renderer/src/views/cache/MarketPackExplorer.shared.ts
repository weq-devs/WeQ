/** 密钥来源 → 中文标签。 */
export function keySourceLabel(source: string): string {
  switch (source) {
    case 'xydata':
      return '元数据种子';
    case 'brute-force':
      return '时间窗爆破';
    case 'manual':
      return '手动派生';
    default:
      return source;
  }
}
