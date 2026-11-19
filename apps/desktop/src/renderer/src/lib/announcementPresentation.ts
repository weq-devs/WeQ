import { createContext, useContext } from 'react';

export const AnnouncementUnread = createContext(0);
const openAnnouncementContext = createContext<() => void>(() => {});
export { openAnnouncementContext as OpenAnnouncement };

export function useOpenAnnouncement() {
  return useContext(openAnnouncementContext);
}

export function useAnnouncementPresentation() {
  return { unread: useContext(AnnouncementUnread), open: useOpenAnnouncement() };
}
