import { useMemo } from 'react';
import type { Conversation, GroupMember, Message, User } from '../im-template/template/types';
import { DOMParser, type Node } from '@xmldom/xmldom';
import { displayUserName } from '../im-template/template/user';
import littleIconUrl from '@resources/img/little_icon.png';

interface GrayTipPokeMessageProps {
  element: {
    type: 'grayTipPoke';
    data?: {
      grayTipXmlContent?: string;
      tipJson?: string;
      /** 动作目标（被戳的人）—— 自带 uid + 昵称快照，见 48210/43210。 */
      actionTarget?: { uid?: string; nickname?: string };
      /** 动作发起者（戳的人）。 */
      actionInitiator?: { uid?: string; nickname?: string };
      /** 附加属性：按出场序平铺的 `nick_str{N}` / `uin_str{N}`。 */
      actionAttributes?: Array<{ key?: string; value?: string }>;
    };
  };
  conversation: Conversation;
  message: Message;
  /**
   * 当前登录用户。
   *
   * 私聊戳一戳的灰条里，**自己的 uid** 就是「谁戳了谁」的一半 —— 之前只把
   * `message.sender` 和会话对端塞进成员表，自己那条查不到名字就退化成裸 uid。
   * 带上当前用户后就能把 uid / uin 还原成自己的昵称。
   */
  user?: User;
}

/** 把「当前用户」也当作可解析的成员塞进成员表（uid / uin 两个键都认）。 */
function addSelf(memberMap: Map<string, GroupMember>, user?: User): void {
  if (!user) return;
  const self = user as unknown as GroupMember;
  if (user.id) memberMap.set(user.id, self);
  if (user.identityValue) memberMap.set(user.identityValue, self);
}

/**
 * 灰条自带的人名解析器 —— 与 `conversationPreview.nameByUid` 同一套口径：
 *   1. 按 uid 命中 `actionTarget` / `actionInitiator` 的昵称快照；
 *   2. 否则按此人在灰条里的出场序取 `actionAttributes` 的 `nick_str{N}` /
 *      `uin_str{N}`（QQ 把参与者按同样顺序平铺在这里）；
 *   3. 再否则退到调用方给的 `uin` 提示（`<qq jp>`），最后才是裸 uid。
 *
 * 私聊戳一戳里「自己」那一半常常只有 uid（谁的 uid 都不在成员表里），这一层就是
 * 为了不把它渲染成一串 base64 / 空白。
 */
function buildNameResolver(data: GrayTipPokeMessageProps['element']['data']) {
  const byUid = new Map<string, string>();
  for (const who of [data?.actionTarget, data?.actionInitiator]) {
    const uid = String(who?.uid ?? '').trim();
    const nick = String(who?.nickname ?? '').trim();
    if (uid && nick) byUid.set(uid, nick);
  }
  const attrs = new Map<string, string>();
  for (const item of data?.actionAttributes ?? []) {
    const key = String(item?.key ?? '').trim();
    if (key) attrs.set(key, String(item?.value ?? '').trim());
  }
  return (uid: string, personIndex: number, uinHint?: string): string => {
    const known = uid ? byUid.get(uid) : undefined;
    if (known) return known;
    return (
      attrs.get(`nick_str${personIndex + 1}`) ||
      attrs.get(`uin_str${personIndex + 1}`) ||
      (uinHint ?? '') ||
      uid
    );
  };
}

function getNodeValue(node: Node, attribute: string): string {
  const attributes = (
    node as Node & {
      attributes?: {
        getNamedItem(name: string): { nodeValue?: string | null } | null;
      };
    }
  ).attributes;
  return attributes?.getNamedItem(attribute)?.nodeValue || '';
}

/** `<nor>正文</nor>` 这种把文字写在元素内容里的写法,属性里没有 `txt`。 */
function getNodeText(node: Node): string {
  return (typeof node.textContent === 'string' ? node.textContent : '').trim();
}

interface TipJsonItem {
  type?: string;
  txt?: string;
  uid?: string;
  uin?: string;
  nm?: string;
  param?: string[];
  src?: string;
}

/**
 * Gray-tip `<img src="...">` icons reference QQ's own bundled asset filenames
 * (e.g. the wallet/red-packet "领取了" tip icon), not real URLs — rendering them
 * raw 404s into a broken-image glyph. Map the known ones to a local asset; let
 * real http(s) srcs through unchanged; drop anything else (unknown bare
 * filename) so no broken image shows.
 */
const LOCAL_TIP_ICONS: Record<string, string> = {
  'qqwallet_custom_tips_icon.png': littleIconUrl,
};

function resolveTipImgSrc(src: string): string | null {
  if (!src) return null;
  if (/^(https?:|data:|file:|asset:)/i.test(src)) return src;
  return LOCAL_TIP_ICONS[src] ?? null;
}

export function GrayTipPokeMessage({
  element,
  conversation,
  message,
  user,
}: GrayTipPokeMessageProps) {
  const { grayTipXmlContent, tipJson } = element.data || {};

  const content = useMemo(() => {
    if (grayTipXmlContent) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(grayTipXmlContent, 'text/xml');
      const gtip = doc.getElementsByTagName('gtip')[0];
      if (!gtip) return null;

      const memberMap = new Map<string, GroupMember>();
      if (message.sender) {
        memberMap.set(message.sender.id, message.sender as GroupMember);
        if (message.sender.identityValue) {
          memberMap.set(message.sender.identityValue, message.sender as GroupMember);
        }
      }
      if (conversation.type === 'group') {
        conversation.members.forEach((m) => {
          memberMap.set(m.id, m);
          if (m.identityValue) {
            memberMap.set(m.identityValue, m);
          }
        });
      } else if (conversation.type === 'direct') {
        memberMap.set(conversation.otherUser.id, conversation.otherUser as GroupMember);
        if (conversation.otherUser.identityValue) {
          memberMap.set(
            conversation.otherUser.identityValue,
            conversation.otherUser as GroupMember,
          );
        }
        // 私聊戳一戳的另一半往往是「自己」（我戳了对方 / 对方戳了我）。
        addSelf(memberMap, user);
      }

      const resolveName = buildNameResolver(element.data);
      let personIndex = 0;
      const nodes = Array.from(gtip.childNodes).map((node, index) => {
        if (node.nodeName === 'qq') {
          const uin = getNodeValue(node, 'uin');
          const uid = getNodeValue(node, 'uid');
          const jp = getNodeValue(node, 'jp');
          const key = uin || uid || jp;
          const member = key ? memberMap.get(key) : undefined;
          // 成员表命中就用群名片；否则退到灰条自带的 nm，再退到元素自带的
          // actionInitiator/Target 昵称 / `uin_str{N}`（自己那条 uid 不在成员表里，
          // 靠这一层还原），最后才是裸 id。
          const name =
            (member ? displayUserName(member) : '') ||
            getNodeValue(node, 'nm') ||
            resolveName(key, personIndex, jp) ||
            key;
          personIndex += 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <span key={index} className="text-blue-500 cursor-pointer hover:underline">
              {name}
            </span>
          );
        }
        if (node.nodeName === 'nor') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <span key={index} className="text-gray-500 px-1">
              {getNodeValue(node, 'txt') || getNodeText(node)}
            </span>
          );
        }
        if (node.nodeName === 'url') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <span key={index} className="text-blue-500">
              {getNodeValue(node, 'txt') || getNodeText(node)}
            </span>
          );
        }
        if (node.nodeName === 'img') {
          const src = resolveTipImgSrc(getNodeValue(node, 'src'));
          return src ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <img key={index} src={src} alt="" className="inline-block h-[1em] mx-1 align-middle" />
          ) : null;
        }
        return null;
      });

      return <div className="weq-graytip text-center text-gray-500 text-xs py-2">{nodes}</div>;
    }

    if (tipJson) {
      try {
        const data = JSON.parse(tipJson) as { items?: TipJsonItem[] };
        const memberMap = new Map<string, GroupMember>();
        if (message.sender) {
          memberMap.set(message.sender.id, message.sender as GroupMember);
          if (message.sender.identityValue) {
            memberMap.set(message.sender.identityValue, message.sender as GroupMember);
          }
        }
        if (conversation.type === 'group') {
          conversation.members.forEach((m) => {
            memberMap.set(m.id, m);
            if (m.identityValue) {
              memberMap.set(m.identityValue, m);
            }
          });
        } else if (conversation.type === 'direct') {
          memberMap.set(conversation.otherUser.id, conversation.otherUser as GroupMember);
          if (conversation.otherUser.identityValue) {
            memberMap.set(
              conversation.otherUser.identityValue,
              conversation.otherUser as GroupMember,
            );
          }
          // 私聊戳一戳的另一半往往是「自己」（同 XML 分支）。
          addSelf(memberMap, user);
        }

        const resolveName = buildNameResolver(element.data);
        let personIndex = 0;
        const items =
          data.items?.map((item) => {
            const txt = item.txt || '';
            const itemKey = `${item.type ?? 'unknown'}-${item.uid ?? item.uin ?? item.param?.[0] ?? ''}-${txt}-${item.src ?? ''}`;

            // `qq` / `url` 都是「人」节点：uid 或 uin 命中群成员就用群名片,
            // 否则退到灰条自带的 nm(手机导入的记录只有 nm、群成员表里查不到),
            // 再退到 txt / 裸 uin。
            if (item.type === 'qq' || item.type === 'url') {
              const key = item.uid || item.uin || item.param?.[0] || '';
              const member = key ? memberMap.get(key) : undefined;
              const name =
                (member ? displayUserName(member) : '') ||
                item.nm ||
                txt ||
                resolveName(key, personIndex, item.uin) ||
                '';
              personIndex += 1;
              if (name) {
                return (
                  <span key={itemKey} className="text-blue-500 cursor-pointer hover:underline">
                    {name}
                  </span>
                );
              }
              return null;
            }

            if (item.type === 'nor') {
              return <span key={itemKey}>{txt}</span>;
            }

            if (item.type === 'img') {
              const src = resolveTipImgSrc(item.src ?? '');
              return src ? (
                <img
                  key={itemKey}
                  src={src}
                  alt=""
                  className="inline-block h-[1em] mx-1 align-middle"
                />
              ) : null;
            }

            return <span key={itemKey}>{txt}</span>;
          }) || [];

        return <div className="weq-graytip text-center text-gray-500 text-xs py-2">{items}</div>;
      } catch (e) {
        console.error('Failed to parse tipJson', e);
        return null;
      }
    }

    return null;
  }, [grayTipXmlContent, tipJson, conversation, message, user, element.data]);

  return content;
}
