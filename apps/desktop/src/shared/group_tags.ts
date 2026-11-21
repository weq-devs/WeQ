export function sameGroupTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag) => right.includes(tag));
}
