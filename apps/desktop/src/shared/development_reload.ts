export const DEVELOPMENT_RELOAD_STATUS = 'weq:development-reload';
export const DEVELOPMENT_RELOAD_QUERY = 'weq:development-reload-query';
export const DEVELOPMENT_RELOAD_APPLY = 'weq:development-reload-apply';
export const DEVELOPMENT_RELOAD_DISMISS = 'weq:development-reload-dismiss';

export interface DevelopmentReloadStatus {
  id: string;
  restart: boolean;
  ready: boolean;
  dismissed?: true;
}
