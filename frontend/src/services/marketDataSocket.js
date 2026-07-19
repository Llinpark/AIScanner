import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config/appUrls';

let sharedSocket = null;

export function getSharedSocket() {
  if (!sharedSocket) {
    sharedSocket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling']
    });
  }

  return sharedSocket;
}

export function disconnectSharedSocket() {
  sharedSocket?.disconnect();
  sharedSocket = null;
}
