import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  GROUP_VIDEO_PORT_CHANNEL,
  GROUP_VIDEO_PUSH_CHANNEL,
  GROUP_VIDEO_SUBSCRIBE_CHANNEL,
  type CallVideoBridge,
  type GroupVideoDelivery,
} from '../shared/call_video_ipc';

type VideoPort = IpcRendererEvent['ports'][number];
let nextSubscription = 0;
const pendingPorts = new Map<number, (port: VideoPort) => void>();
ipcRenderer.on(GROUP_VIDEO_PORT_CHANNEL, (event, subscription: number) => {
  const [port] = event.ports;
  if (!port) return;
  const connect = pendingPorts.get(subscription);
  pendingPorts.delete(subscription);
  if (connect) connect(port);
  else port.close();
});

export const groupVideoBridge: Pick<CallVideoBridge, 'pushGroupFrame' | 'subscribeGroup'> = {
  pushGroupFrame: (frame) => ipcRenderer.invoke(GROUP_VIDEO_PUSH_CHANNEL, frame),
  subscribeGroup(id, onFrame) {
    const subscription = ++nextSubscription;
    let port: VideoPort | undefined;
    pendingPorts.set(subscription, (received) => {
      port = received;
      received.onmessage = ({ data }: { data: GroupVideoDelivery & { seq: number } }) => {
        const { seq, ...frame } = data;
        try {
          onFrame(frame);
        } finally {
          received.postMessage(seq);
        }
      };
    });
    ipcRenderer.send(GROUP_VIDEO_SUBSCRIBE_CHANNEL, id, subscription);
    return () => {
      pendingPorts.delete(subscription);
      if (!port) return;
      port.postMessage('close');
      port.close();
      port = undefined;
    };
  },
};
