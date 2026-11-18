import { randomInt } from 'node:crypto';
import { ExpressPeerServer } from 'peer';

// Peer ids double as the 6-digit share codes shown in the UI: the sender
// registers under the code and the receiver connects to it. PeerServer
// re-rolls on collision with a connected peer.
const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function createPeerServer(httpServer) {
  return ExpressPeerServer(httpServer, {
    path: '/',
    generateClientId: sixDigitCode,
    allow_discovery: false,
  });
}
