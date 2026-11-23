import catalog from '../../../../resources/emoji/emoji_config.json';
import { classicPanelFaces } from '../account/emoji_panel_catalog';

const descriptions = new Map<string, string>(
  classicPanelFaces.map(([id, name]) => [id, `/${name}`]),
);
for (const { QSid, QDes } of catalog) descriptions.set(QSid, QDes);

export function bundledSystemFaceText(faceId: number | string): string | undefined {
  return descriptions.get(String(faceId));
}

export function suppliedSystemFaceText(faceId: number | string, text?: string): string | undefined {
  const description = text?.trim();
  return description && description !== `[表情${faceId}]` ? description : undefined;
}
