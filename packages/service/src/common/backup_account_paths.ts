export const WEQ_ACCOUNT_SETTING_FILES = [
  'anti-recall.json',
  'intent.json',
  'tolerance.json',
  'dress.json',
] as const;
export type WeqAccountSettingFile = (typeof WEQ_ACCOUNT_SETTING_FILES)[number];
export const WEQ_BACKGROUND_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'mp4',
  'webm',
  'mov',
] as const;

export function isWeqBackgroundName(value: string): boolean {
  return /^bg-[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|gif|bmp|mp4|webm|mov)$/.test(value);
}
