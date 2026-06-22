import { useMemo } from 'react';
import type { Conversation, GroupMember, Message } from '../im-template/template/types';
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
  message: Message;
}

function getNodeValue(node: any, attribute: string): string {
  return node.attributes.getNamedItem(attribute)?.nodeValue || '';
}

export function GrayTipPokeMessage({ element, conversation, message }: GrayTipPokeMessageProps) {
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
          return <img key={index} src={src} alt="poke" className="inline-block h-[1em] mx-1" />;
        }
        return null;
      });

      return <div className="text-center text-gray-500 text-xs py-2">{nodes}</div>;
    }

    if (tipJson) {
      try {
        const data = JSON.parse(tipJson);
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
                memberMap.set(conversation.otherUser.identityValue, conversation.otherUser as GroupMember);
            }
        }

        const items = data.items?.map((item:any, index:number) => {
          const txt = item.txt || '';

          if (item.type === 'url') {
            const uin = item.uin || item.param?.[0];
            if (uin) {
              const member = memberMap.get(uin);
              const name = member ? displayUserName(member) : txt;
              return (
                <span key={index} className="text-blue-500 cursor-pointer hover:underline">
                  {name}
                </span>
              );
            }
            return <span key={index} className="text-blue-500">{txt}</span>;
          }

          if (item.type === 'nor') {
            return <span key={index}>{txt}</span>;
          }

          if (item.type === 'img') {
            const src = item.src;
            return src ? <img key={index} src={src} alt="" className="inline-block h-[1em] mx-1" /> : null;
          }

          return <span key={index}>{txt}</span>;
        }) || [];

        return <div className="text-center text-gray-500 text-xs py-2">{items}</div>;
      } catch (e) {
        console.error('Failed to parse tipJson', e);
        return null;
      }
    }

    return null;
  }, [grayTipXmlContent, tipJson, conversation, message]);

  return content;
}
