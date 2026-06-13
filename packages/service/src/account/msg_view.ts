/**
 * Render View Model — defines simplified, front-end-friendly Element shapes.
 */

import type {
  Element,
  TextElement,
  PicElement,
  FileElement,
  VideoElement,
  PttElement,
  FaceElement,
  ReplyElement,
  GrayTipRevokeElement,
  GrayTipPokeElement,
  GrayTipGroupElement,
  ArkElement,
  MfaceElement,
  MarkdownElement,
  MultiMsgElement,
  CallElement,
  WalletElement,
  OnlineFileElement,
  OnlineFolderElement,
  EmojiBounceElement,
  QqDynamicElement,
  UnknownElement,
  AtElement,
} from '@weq/codec';

/** Base fields shared by all render elements. */
interface BaseRenderElement {
  /** The mapped name for 'kind' discriminator. */
  type: string;
}

export type RenderTextElement = Omit<TextElement, 'kind'> & { type: 'text' };
export type RenderAtElement = Omit<AtElement, 'kind'> & { type: 'at' };
export type RenderPicElement = Omit<PicElement, 'kind'> & { type: 'pic' };
export type RenderFileElement = Omit<FileElement, 'kind'> & { type: 'file' };
export type RenderVideoElement = Omit<VideoElement, 'kind'> & { type: 'video' };
export type RenderPttElement = Omit<PttElement, 'kind'> & { type: 'ptt' };
export type RenderFaceElement = Omit<FaceElement, 'kind'> & { type: 'face' };
export type RenderReplyElement = Omit<ReplyElement, 'kind'> & { type: 'reply' };
export type RenderGrayTipRevokeElement = Omit<GrayTipRevokeElement, 'kind'> & { type: 'grayTipRevoke' };
export type RenderGrayTipPokeElement = Omit<GrayTipPokeElement, 'kind'> & { type: 'grayTipPoke' };
export type RenderGrayTipGroupElement = Omit<GrayTipGroupElement, 'kind'> & { type: 'grayTipGroup' };
export type RenderArkElement = Omit<ArkElement, 'kind'> & { type: 'ark' };
export type RenderMfaceElement = Omit<MfaceElement, 'kind'> & { type: 'mface' };
export type RenderMarkdownElement = Omit<MarkdownElement, 'kind'> & { type: 'markdown' };
export type RenderMultiMsgElement = Omit<MultiMsgElement, 'kind'> & { type: 'multiMsg' };
export type RenderCallElement = Omit<CallElement, 'kind'> & { type: 'call' };
export type RenderWalletElement = Omit<WalletElement, 'kind'> & { type: 'wallet' };
export type RenderOnlineFileElement = Omit<OnlineFileElement, 'kind'> & { type: 'onlineFile' };
export type RenderOnlineFolderElement = Omit<OnlineFolderElement, 'kind'> & { type: 'onlineFolder' };
export type RenderEmojiBounceElement = Omit<EmojiBounceElement, 'kind'> & { type: 'emojiBounce' };
export type RenderQqDynamicElement = Omit<QqDynamicElement, 'kind'> & { type: 'qqDynamic' };
export type RenderUnknownElement = Omit<UnknownElement, 'kind'> & { type: 'unknown' };

export type RenderElement =
  | RenderTextElement
  | RenderAtElement
  | RenderPicElement
  | RenderFileElement
  | RenderVideoElement
  | RenderPttElement
  | RenderFaceElement
  | RenderReplyElement
  | RenderGrayTipRevokeElement
  | RenderGrayTipPokeElement
  | RenderGrayTipGroupElement
  | RenderArkElement
  | RenderMfaceElement
  | RenderMarkdownElement
  | RenderMultiMsgElement
  | RenderCallElement
  | RenderWalletElement
  | RenderOnlineFileElement
  | RenderOnlineFolderElement
  | RenderEmojiBounceElement
  | RenderQqDynamicElement
  | RenderUnknownElement;

export function toRenderElements(elements: Element[]): RenderElement[] {
  return elements.map((el) => {
    const { kind, ...rest } = el;
    // Map 'kind' to 'type' for all elements.
    const base = { type: kind, ...rest };

    switch (kind) {
      case 'text':
        return mapText(el as TextElement);
      case 'at':
      case 'pic':
      case 'file':
      case 'video':
      case 'ptt':
      case 'face':
      case 'reply':
      case 'grayTipRevoke':
      case 'grayTipPoke':
      case 'grayTipGroup':
      case 'ark':
      case 'mface':
      case 'markdown':
      case 'multiMsg':
      case 'call':
      case 'wallet':
      case 'onlineFile':
      case 'onlineFolder':
      case 'emojiBounce':
      case 'qqDynamic':
      case 'unknown':
        return base as RenderElement;
      default:
        return base as RenderElement;
    }
  });
}

function mapText(el: TextElement): RenderTextElement {
  return {
    type: 'text',
    textContent: el.textContent ?? '',
  };
}
