import { useRestrictedMode, type AuthorizationRequest } from '../state/restrictedMode';
import '../styles/restricted-mode.css';

export const QQ_STATUS_DETAILS_ID = 'qq-function-status-details';

export function ipc() {
  return window.electron?.ipcRenderer;
}

export function cancelAuthorizationRequest(request: AuthorizationRequest): void {
  if (request.kind === 'password')
    ipc()?.send('elev:respond-password', { token: request.token, password: null });
  else ipc()?.send('attach:respond-hint', { token: request.token, choice: 'cancel', password: '' });
  useRestrictedMode.getState().remove(request.kind, request.token);
}
