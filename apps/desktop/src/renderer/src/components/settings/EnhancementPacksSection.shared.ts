import '../../styles/enhancement-packs.css';

export function enhancementBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
