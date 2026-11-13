export type GroupResourceKind = 'albums' | 'files';
export type GroupResourceWindowName = `weq-group-resource:${GroupResourceKind}:${string}:${string}`;

export function groupResourceWindowName(
  owner: string,
  groupCode: string,
  kind: GroupResourceKind,
): GroupResourceWindowName {
  return `weq-group-resource:${kind}:${encodeURIComponent(owner)}:${groupCode}`;
}

/** 子窗只能属于明确的账号来源和真实 QQ 群，不放行任意 about:blank 名称。 */
export function readGroupResourceWindowName(name: string) {
  const match = /^weq-group-resource:(albums|files):([^:]+):([1-9]\d{0,19})$/.exec(name);
  if (!match) return null;
  try {
    const owner = decodeURIComponent(match[2]!);
    if (!owner.trim() || encodeURIComponent(owner) !== match[2]) return null;
    return { kind: match[1] as GroupResourceKind, owner, groupCode: match[3]! };
  } catch {
    return null;
  }
}
