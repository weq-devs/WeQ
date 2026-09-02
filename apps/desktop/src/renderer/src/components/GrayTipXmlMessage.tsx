import { useMemo } from 'react';
import type { Conversation, GroupMember } from '../im-template/template/types';
import { DOMParser, type Node } from '@xmldom/xmldom';
import { displayUserName } from '../im-template/template/user';
import { FaceEmoji } from './FaceEmoji';

interface GrayTipXmlMessageProps {
  element: {
    type: 'grayTipXml';
    data?: {
      grayTipXmlContent?: string;
    };
  };
  conversation: Conversation;
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

export function GrayTipXmlMessage({ element, conversation }: GrayTipXmlMessageProps) {
  const { grayTipXmlContent } = element.data || {};

  const content = useMemo(() => {
    if (!grayTipXmlContent) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(grayTipXmlContent, 'text/xml');
    const gtip = doc.getElementsByTagName('gtip')[0];
    if (!gtip) return null;

    const memberMap = new Map<string, GroupMember>();
    if (conversation.type === 'group') {
      conversation.members.forEach((m) => {
        memberMap.set(m.id, m);
        if (m.identityValue) {
          memberMap.set(m.identityValue, m);
        }
      });
    }

    const nodes = Array.from(gtip.childNodes).map((node, index) => {
      if (node.nodeName === 'qq') {
        const uin = getNodeValue(node, 'uin');
        const member = memberMap.get(uin);
        const name = member ? displayUserName(member) : getNodeValue(node, 'nm') || uin;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <span key={index} className="text-blue-500">
            {name}
          </span>
        );
      }
      if (node.nodeName === 'nor') {
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
        return <span key={index}>{getNodeValue(node, 'txt') || getNodeText(node)}</span>;
      }
      if (node.nodeName === 'url') {
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
          <span key={index} className="text-blue-500">
            {getNodeValue(node, 'txt') || getNodeText(node)}
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

    return <div className="weq-graytip text-center text-gray-500 text-xs py-2">{nodes}</div>;
  }, [grayTipXmlContent, conversation]);

  return content;
}
