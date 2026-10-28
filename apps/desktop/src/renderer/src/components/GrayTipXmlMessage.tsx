import { useContext, useMemo } from 'react';
import type { Conversation, GroupMember, Message, User } from '../im-template/template/types';
import { DOMParser, type Node } from '@xmldom/xmldom';
import { displayUserName } from '../im-template/template/user';
import { FaceEmoji } from './FaceEmoji';
import { GrayTipPerson } from './GrayTipPerson';
import { createGrayTipPersonKey } from '../lib/grayTipProfile';
import { ReplyJumpContext } from './QqMessageContent';
import '../styles/gray-tip-message.css';

interface GrayTipXmlMessageProps {
  element: {
    type: 'grayTipXml';
    data?: {
      grayTipXmlContent?: string;
    };
  };
  conversation?: Conversation;
  message?: Message;
  user?: User;
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

export function GrayTipXmlMessage({
  element,
  conversation,
  message,
  user,
}: GrayTipXmlMessageProps) {
  const { grayTipXmlContent } = element.data || {};
  const jumpToMessage = useContext(ReplyJumpContext);

  const content = useMemo(() => {
    if (!grayTipXmlContent) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(grayTipXmlContent, 'text/xml');
    const gtip = doc.getElementsByTagName('gtip')[0];
    if (!gtip) return null;

    const memberMap = new Map<string, GroupMember>();
    if (conversation?.type === 'group') {
      conversation.members.forEach((m) => {
        memberMap.set(m.id, m);
        if (m.identityValue) {
          memberMap.set(m.identityValue, m);
        }
      });
    }

    const personKey = createGrayTipPersonKey();
    const messageLinks = new Map<string, number>();
    const nodes = Array.from(gtip.childNodes).map((node, index) => {
      if (node.nodeName === 'qq') {
        const uin = getNodeValue(node, 'uin');
        const uid = getNodeValue(node, 'uid');
        const jp = getNodeValue(node, 'jp');
        const member = memberMap.get(uin) || memberMap.get(uid) || memberMap.get(jp);
        const name = member
          ? displayUserName(member)
          : getNodeValue(node, 'nm') || uin || uid || jp;
        return (
          <GrayTipPerson
            key={personKey([uin, uid, jp], name)}
            identities={[uin, uid, jp]}
            name={name}
            conversation={conversation}
            message={message}
            user={user}
          />
        );
      }
      if (node.nodeName === 'nor') {
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
        return <span key={index}>{getNodeValue(node, 'txt') || getNodeText(node)}</span>;
      }
      if (node.nodeName === 'url') {
        const seq = getNodeValue(node, 'msgseq');
        const text = getNodeValue(node, 'txt') || getNodeText(node);
        if (/^\d+$/.test(seq) && BigInt(seq) > 0n) {
          const occurrence = messageLinks.get(seq) ?? 0;
          messageLinks.set(seq, occurrence + 1);
          return (
            <button
              key={`message-${seq}-${occurrence}`}
              type="button"
              className="weq-graytip-accent weq-graytip-message-link"
              title="跳转到原消息"
              onClick={(event) => {
                event.stopPropagation();
                jumpToMessage({ seq });
              }}
            >
              {text}
            </button>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <span key={index} className="weq-graytip-accent">
            {text}
          </span>
        );
      }
      if (node.nodeName === 'face') {
        const faceId = Number(getNodeValue(node, 'id'));
        return (
          <FaceEmoji
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            key={index}
            element={{ faceId }}
            size="1.2em"
            className="inline-block align-middle mx-0.5"
          />
        );
      }
      return null;
    });

    return <div className="weq-graytip text-center text-xs py-2">{nodes}</div>;
  }, [grayTipXmlContent, conversation, message, user, jumpToMessage]);

  return content;
}
