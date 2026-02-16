/**
 * Cloudflare Worker signaling server for Shiroya Send.
 * Protocol:
 *  - client -> {type:'join', roomId, roomKeyHash, rtcSupported}
 *  - server -> {type:'welcome', peers:[...]}
 *  - server -> {type:'peer-joined', peer:{id,name,rtcSupported}}
 *  - server -> {type:'peer-left', peerId}
 *  - relay  -> {type:'signal', to, sender, sdp|ice}
 */

const rooms = new Map();

export default {
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Shiroya Send signaling worker is running.', { status: 200 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const peer = {
      id: crypto.randomUUID(),
      socket: server,
      roomId: null,
      roomKeyHash: '',
      name: randomName(),
      rtcSupported: true
    };

    server.addEventListener('message', event => {
      try {
        const msg = JSON.parse(event.data);
        onMessage(peer, msg);
      } catch (error) {
        server.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
      }
    });

    server.addEventListener('close', () => leaveRoom(peer));
    server.addEventListener('error', () => leaveRoom(peer));

    return new Response(null, { status: 101, webSocket: client });
  }
};

function onMessage(peer, msg) {
  switch (msg.type) {
    case 'join':
      joinRoom(peer, msg);
      break;
    case 'signal':
      relaySignal(peer, msg);
      break;
    case 'disconnect':
      leaveRoom(peer);
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function joinRoom(peer, msg) {
  const roomId = String(msg.roomId || '').trim();
  if (!roomId) return;

  const keyHash = String(msg.roomKeyHash || '');
  const room = getOrCreateRoom(roomId, keyHash);

  if (room.keyHash && keyHash !== room.keyHash) {
    peer.socket.send(JSON.stringify({ type: 'room-key-mismatch' }));
    return;
  }

  if (!room.keyHash && keyHash) {
    room.keyHash = keyHash;
  }

  if (peer.roomId && peer.roomId !== roomId) {
    leaveRoom(peer);
  }

  peer.roomId = roomId;
  peer.roomKeyHash = keyHash;
  peer.rtcSupported = msg.rtcSupported !== false;

  room.peers.set(peer.id, peer);

  const peers = [...room.peers.values()]
    .filter(p => p.id !== peer.id)
    .map(p => asPeerInfo(p));

  peer.socket.send(JSON.stringify({
    type: 'welcome',
    peerId: peer.id,
    roomId,
    peers,
    displayName: peer.name.displayName,
    deviceName: peer.name.deviceName
  }));

  broadcast(room, {
    type: 'peer-joined',
    peer: asPeerInfo(peer)
  }, peer.id);
}

function relaySignal(peer, msg) {
  if (!peer.roomId) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;
  const target = room.peers.get(msg.to);
  if (!target) return;
  target.socket.send(JSON.stringify({
    type: 'signal',
    sender: peer.id,
    sdp: msg.sdp,
    ice: msg.ice
  }));
}

function leaveRoom(peer) {
  if (!peer.roomId) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;

  room.peers.delete(peer.id);
  broadcast(room, { type: 'peer-left', peerId: peer.id }, peer.id);

  if (room.peers.size === 0) {
    rooms.delete(peer.roomId);
  }

  peer.roomId = null;
}

function getOrCreateRoom(roomId, keyHash) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { keyHash, peers: new Map() });
  }
  return rooms.get(roomId);
}

function asPeerInfo(peer) {
  return {
    id: peer.id,
    rtcSupported: peer.rtcSupported,
    name: peer.name
  };
}

function broadcast(room, payload, exceptId = null) {
  const data = JSON.stringify(payload);
  room.peers.forEach(peer => {
    if (exceptId && peer.id === exceptId) return;
    try {
      peer.socket.send(data);
    } catch (_) {
      // ignore stale sockets
    }
  });
}

function randomName() {
  const devices = ['Desktop', 'Mobile', 'Tablet'];
  const adjectives = ['Swift', 'Bright', 'Silent', 'Azure', 'Rapid'];
  const nouns = ['Otter', 'Falcon', 'Panda', 'Lynx', 'Fox'];

  const displayName = `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}`;
  const deviceName = `${displayName} ${devices[Math.floor(Math.random() * devices.length)]}`;

  return {
    displayName,
    deviceName,
    device: { type: 'desktop' }
  };
}
