/** 杂项：OCR / 解密密钥 / clientKey / rkey / pskey / 红包皮肤 / Ark / AI 语音 / 群报名。 */
export {
  OcrImage,
  OCR_CLIENT_TAG,
  OCR_TASK_TYPE,
  quadToRect,
  rectToQuad,
  scaleOcrPoints,
  scaleOcrRect,
} from './ocr-image';
export type { OcrBlock, OcrLanguage, OcrPoint, OcrRect, OcrResult } from './ocr-image';
export { RequestDecryptKey } from './request-decrypt-key';
export { FetchClientKey } from './fetch-client-key';
export type { ClientKeyInfo } from './fetch-client-key';
export { FetchDownloadRkeys } from './fetch-download-rkeys';
export type { DownloadRkey } from './fetch-download-rkeys';
export { FetchPskeyOidb } from './fetch-pskey';
export { GetRedPackSkin, RED_PACK_SKIN_TRACE_ID } from './get-red-pack-skin';
export type {
  RedPackSkinInfo,
  RedPackSkinCover,
  RedPackSkinJump,
  RedPackSkinImage,
  RedPackSkinResponse,
} from './get-red-pack-skin';
export { SendTuwenArk } from './send-tuwen-ark';
export type { SendTuwenArkParams, SendTuwenArkResult } from './send-tuwen-ark';
export {
  GetBuddyRecommendArk,
  GetGroupRecommendArk,
  getContactArk,
  sendBuddyContactArk,
  sendContactArk,
  sendGroupContactArk,
} from './send-contact-ark';
export type {
  BuddyRecommendArkParams,
  ContactArkKind,
  ContactArkNative,
  ContactArkPeerType,
  GroupRecommendArkParams,
  SendContactArkParams,
  SendContactArkResult,
} from './send-contact-ark';
export { SendLocationArk, LOCATION_ARK_CMD } from './send-location-ark';
export type { SendLocationArkParams } from './send-location-ark';
export { SendAiVoice } from './send-ai-voice';
export type {
  SendAiVoiceParams,
  SendAiVoiceResult,
  AiVoiceFileInfo,
} from './send-ai-voice';
export {
  SendGroupSignup,
  SIGNUP_METHOD_DIRECT,
  SIGNUP_METHOD_IMAGE,
  SIGNUP_MAX_COUNT_DEFAULT,
  SIGNUP_FIELD10_DEFAULT,
} from './send-group-signup';
export type {
  SendGroupSignupParams,
  SendGroupSignupImage,
} from './send-group-signup';
