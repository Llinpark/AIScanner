import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config/appUrls';

let sharedSocket = null;
let sharedToken = null;

export function getSharedSocket(token) {
  if (!token) return null;

  if (!sharedSocket || sharedToken !== token) {
    sharedSocket?.disconnect();
    sharedSocket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    sharedToken = token;
  }

  return sharedSocket;
}

export function releaseSharedSocket() {
  // Keep one socket alive for the SPA session; individual hooks manage listeners only.
}
