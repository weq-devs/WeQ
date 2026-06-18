import { useMemo } from 'react';
import type { Conversation, GroupMember } from '../im-template/template/types';
import { DOMParser } from '@xmldom/xmldom';
import { displayUserName } from '../im-template/template/user';

interface GrayTipPokeMessageProps {
  element: {
    type: 'grayTipPoke';
    data?: {
      grayTipXmlContent?: string;
      tipJson?: string;
    };
  };
  conversation: Conversation;
}

function getNodeValue(node: any, attribute: string): string {
  return node.attributes.getNamedItem(attribute)?.nodeValue || '';
}

export function GrayTipPokeMessage({ element, conversation }: GrayTipPokeMessageProps) {
  const { grayTipXmlContent, tipJson } = element.data || {};

  const content = useMemo(() => {
    if (grayTipXmlContent) {
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
      } else if (conversation.type === 'direct') {
        memberMap.set(conversation.otherUser.id, conversation.otherUser as GroupMember);
        if (conversation.otherUser.identityValue) {
          memberMap.set(conversation.otherUser.identityValue, conversation.otherUser as GroupMember);
        }
      }


      const nodes = Array.from(gtip.childNodes).map((node, index) => {
        if (node.nodeName === 'qq') {
          const uin = getNodeValue(node, 'uin');
          const member = memberMap.get(uin);
          const name = member ? displayUserName(member) : getNodeValue(node, 'nm') || uin;
          return (
            <span key={index} className="text-blue-500 cursor-pointer hover:underline">
              {name}
            </span>
          );
        }
        if (node.nodeName === 'nor') {
          return <span key={index} className="text-gray-500 px-1">{getNodeValue(node, 'txt')}</span>;
        }
        if (node.nodeName === 'img') {
          const src = getNodeValue(node, 'src');
          return <img key={index} src={src} alt="poke" className="inline-block w-5 h-5 mx-1" />;
        }
        return null;
      });

      return <div className="text-center text-gray-500 text-xs py-2">{nodes}</div>;
    }

    if (tipJson) {
      try {
        const data = JSON.parse(tipJson);
        const memberMap = new Map<string, GroupMember>();
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
                memberMap.set(conversation.otherUser.identityValue, conversation.otherUser as GroupMember);
            }
        }

        const items = data.items.map((item:any, index:number) => {
          if (item.type === 'url') {
            const uin = item.uin;
            let name = item.txt;
            if (uin) {
                const member = memberMap.get(uin);
                name = member ? displayUserName(member) : name;
            }
            return (
              <span key={index} className="text-blue-500 cursor-pointer hover:underline">
                {name}
              </span>
            );
          }
          if (item.type === 'nor') {
            return <span key={index} className="text-gray-500 px-1"> {item.txt} </span>;
          }
          return null;
        });

        return <div className="text-center text-gray-500 text-xs py-2">{items}</div>;
      } catch (e) {
        console.error('Failed to parse tipJson', e);
        return null;
      }
    }

    return null;
  }, [grayTipXmlContent, tipJson, conversation]);

  return content;
}
