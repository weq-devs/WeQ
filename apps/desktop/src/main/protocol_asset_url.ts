/** 与 Web protocol_adapter 同规则，把同源媒体／资源挂载路径转回已有协议。 */
export function toProtocolAssetUrl(raw: string): string | null {
  if (raw.startsWith('weq-media://') || raw.startsWith('weq-asset://')) return raw;

  const MOUNTS = [
    ['/_media/', 'weq-media'],
    ['/_asset/', 'weq-asset'],
  ] as const;
  for (const [mount, scheme] of MOUNTS) {
    if (!raw.startsWith(mount)) continue;
    const rest = raw.slice(mount.length);
    if (!rest) return null;
    // `/_media/pic?x=1` → `weq-media://pic?x=1`；
    // `/_asset/emoji/358/apng/358.png` → `weq-asset://emoji/358/apng/358.png`
    const qMark = rest.indexOf('?');
    const pathPart = qMark === -1 ? rest : rest.slice(0, qMark);
    const query = qMark === -1 ? '' : rest.slice(qMark);
    const slash = pathPart.indexOf('/');
    const host = slash === -1 ? pathPart : pathPart.slice(0, slash);
    const path = slash === -1 ? '' : pathPart.slice(slash);
    if (!host) return null;
    return `${scheme}://${host}${path}${query}`;
  }
  return null;
}
