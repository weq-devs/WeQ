/** QQ 的自定义表情可能换下载凭据，内容指纹仍相同。旧消息可从文件名取指纹。 */
export function chatStickerMd5(md5: string | null, name: string | null): string | undefined {
  const hash =
    md5 && /^[a-f0-9]{32}$/i.test(md5)
      ? md5
      : /^([a-f0-9]{32})(?:\.[a-z0-9]+)?$/i.exec(name ?? '')?.[1];
  return hash?.toLowerCase();
}
