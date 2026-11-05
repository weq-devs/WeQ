import { z } from 'zod';
import { normalizeExportContent } from '@weq/service/export-content';
const tier = z.enum(['none', 'local', 'cloud']);
export const exportExtraInput = z
  .object({
    qzoneInteractions: z.boolean(),
    collectionProperties: z.boolean(),
    mailProperties: z.boolean(),
    generatedParameters: z.boolean(),
    directoryProperties: z.boolean(),
    resourceProperties: z.boolean(),
  })
  .partial();
export const exportContentPolicyInput = z
  .object({
    messages: tier,
    voice: tier,
    images: tier,
    videos: tier,
    files: tier,
    bubble: tier,
    font: tier,
    avatar: tier,
    widget: tier,
    qqFaces: z.enum(['none', 'local']),
    profiles: tier.optional(),
    details: z
      .object({
        messageProperties: tier,
        profiles: tier,
        protocol: tier,
        voiceProperties: tier,
        voiceVariants: tier,
        imageProperties: tier,
        imageVariants: tier,
        videoProperties: tier,
        videoVariants: tier,
        fileProperties: tier,
        fileVariants: tier,
        bubbleProperties: tier,
        fontProperties: tier,
        avatarProperties: tier,
        avatarVariants: tier,
        widgetProperties: tier,
        qqFaceProperties: tier,
        qqFaceVariants: tier,
      })
      .partial()
      .optional(),
  })
  .transform((value) => normalizeExportContent(value));
