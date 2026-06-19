import { useMemo } from 'react';
import type { Conversation, GroupMember } from '../im-template/template/types';
import { DOMParser } from '@xmldom/xmldom';
import { displayUserName } from '../im-template/template/user';
import { FaceEmoji } from './FaceEmoji';

interface GrayTipInviteMessageProps {
  element: {
    type: 'grayTipInvite';
    data?: {
      grayTipXmlContent?: string;
    };
  };
  conversation: Conversation;
}

function getNodeValue(node: any, attribute: string): string {
  return node.attributes.getNamedItem(attribute)?.nodeValue || '';
}

export function GrayTipInviteMessage({ element, conversation }: GrayTipInviteMessageProps) {
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
          <span key={index} className="text-blue-500">
            {name}
          </span>
        );
      }
      if (node.nodeName === 'nor') {
        return <span key={index}>{getNodeValue(node, 'txt')}</span>;
      }
      if (node.nodeName === 'url') {
        return <span key={index} className="text-blue-500">{getNodeValue(node, 'txt')}</span>;
      }
      if (node.nodeName === 'face') {
        const faceId = Number(getNodeValue(node, 'id'));
        return <FaceEmoji key={index} element={{ faceId }} size="1.2em" className="inline-block align-middle mx-0.5" />;
      }
      return null;
    });

    return <div className="text-center text-gray-500 text-xs py-2">{nodes}</div>;
  }, [grayTipXmlContent, conversation]);

  return content;
}
