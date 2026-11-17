export const DEVELOPMENT_RELOAD_STATUS = 'weq:development-reload';
export const DEVELOPMENT_RELOAD_QUERY = 'weq:development-reload-query';
export const DEVELOPMENT_RELOAD_APPLY = 'weq:development-reload-apply';

export interface DevelopmentReloadStatus {
  id: string;
  restart: boolean;
  ready: boolean;
}
