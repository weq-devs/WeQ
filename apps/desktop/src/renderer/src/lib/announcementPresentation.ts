import { createContext, useContext } from 'react';

export const AnnouncementUnread = createContext(0);
export const OpenAnnouncement = createContext<() => void>(() => {});

export function useOpenAnnouncement() {
  return useContext(OpenAnnouncement);
}

export function useAnnouncementPresentation() {
  return { unread: useContext(AnnouncementUnread), open: useOpenAnnouncement() };
}
