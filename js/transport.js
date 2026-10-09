// Transport layer: moves JSON messages between the host and its clients, nothing else.
// Both implementations expose the same interface, so the game never knows which one is used:
//
//   openHost(code, { onPeer, onData, onPeerClose })  -> Promise<{ send(connId, msg), close(connId), destroy() }>
//   connectClient(code, { onData, onClose })          -> Promise<{ send(msg), destroy() }>
//
// Promises reject with an Error whose `type` is 'taken' (room code in use), 'notfound' or 'network'.

const PEER_PREFIX = 'brashaus-';
const CONNECT_TIMEOUT = 12000;

const transportError = (type, cause) => Object.assign(new Error(type), { type, cause });

// --- PeerJS (WebRTC): the real thing ---------------------------------------------------------

const peerJs = {
  openHost(code, h) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_PREFIX + code, { debug: 1 });
      const conns = new Map();
      let opened = false;
      let seq = 0;

      peer.on('error', (err) => {
        if (opened) return console.warn('[peer]', err.type, err);
        peer.destroy();
        reject(transportError(err.type === 'unavailable-id' ? 'taken' : 'network', err));
      });
      // Losing the broker does not drop existing data channels; reconnect so new players can join.
      peer.on('disconnected', () => {
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
      });
      peer.on('connection', (conn) => {
        const id = `p${++seq}`;
        conn.on('open', () => {
          conns.set(id, conn);
          h.onPeer?.(id);
        });
        conn.on('data', (msg) => conns.has(id) && h.onData(id, msg));
        const dropped = () => conns.delete(id) && h.onPeerClose(id);
        conn.on('close', dropped);
        conn.on('error', dropped);
      });
      peer.on('open', () => {
        opened = true;
        resolve({
          send(id, msg) {
            const conn = conns.get(id);
            if (conn?.open) conn.send(msg);
          },
          close(id) {
            const conn = conns.get(id);
            if (!conn) return;
            conns.delete(id);
            conn.close();
            h.onPeerClose(id);
          },
          destroy() {
            conns.clear();
            peer.destroy();
          },
        });
      });
    });
  },

  connectClient(code, h) {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ debug: 1 });
      let opened = false;
      let closed = false;
      const shutdown = (type, cause) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        peer.destroy();
        if (opened) h.onClose();
        else reject(transportError(type, cause));
      };
      const timer = setTimeout(() => shutdown('notfound'), CONNECT_TIMEOUT);

      peer.on('error', (err) => shutdown(err.type === 'peer-unavailable' ? 'notfound' : 'network', err));
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          opened = true;
          clearTimeout(timer);
          resolve({
            send: (msg) => conn.open && conn.send(msg),
            destroy: () => shutdown(),
          });
        });
        conn.on('data', (msg) => !closed && h.onData(msg));
        conn.on('close', () => shutdown('network'));
        conn.on('error', (err) => shutdown('network', err));
      });
    });
  },
};

// --- BroadcastChannel: same-browser tabs only, for offline testing (add ?local to the URL) ----

const channelName = (code) => `brashaus-local-${code}`;

const local = {
  openHost(code, h) {
    const ch = new BroadcastChannel(channelName(code));
    const peers = new Set();
    ch.onmessage = ({ data: m }) => {
      if (m.to !== 'host') return;
      if (m.kind === 'connect') {
        peers.add(m.from);
        ch.postMessage({ to: m.from, kind: 'accept' });
        h.onPeer?.(m.from);
      } else if (m.kind === 'data' && peers.has(m.from)) {
        h.onData(m.from, m.data);
      } else if (m.kind === 'close' && peers.delete(m.from)) {
        h.onPeerClose(m.from);
      }
    };
    return Promise.resolve({
      send: (id, msg) => peers.has(id) && ch.postMessage({ to: id, kind: 'data', data: msg }),
      close(id) {
        if (!peers.delete(id)) return;
        ch.postMessage({ to: id, kind: 'close' });
        h.onPeerClose(id);
      },
      destroy() {
        for (const id of peers) ch.postMessage({ to: id, kind: 'close' });
        peers.clear();
        ch.close();
      },
    });
  },

  connectClient(code, h) {
    return new Promise((resolve, reject) => {
      const ch = new BroadcastChannel(channelName(code));
      const me = `l${Math.random().toString(36).slice(2, 10)}`;
      let opened = false;
      let closed = false;
      const shutdown = (notifyHost) => {
        if (closed) return;
        closed = true;
        if (notifyHost) ch.postMessage({ to: 'host', from: me, kind: 'close' });
        ch.close();
        removeEventListener('pagehide', onHide);
        if (opened) h.onClose();
      };
      const onHide = () => shutdown(true);
      addEventListener('pagehide', onHide);

      const timer = setTimeout(() => {
        shutdown(false);
        reject(transportError('notfound'));
      }, 1500);
      ch.onmessage = ({ data: m }) => {
        if (m.to !== me) return;
        if (m.kind === 'accept' && !opened) {
          opened = true;
          clearTimeout(timer);
          resolve({
            send: (msg) => !closed && ch.postMessage({ to: 'host', from: me, kind: 'data', data: msg }),
            destroy: () => shutdown(true),
          });
        } else if (m.kind === 'data') {
          h.onData(m.data);
        } else if (m.kind === 'close') {
          shutdown(false);
        }
      };
      ch.postMessage({ to: 'host', from: me, kind: 'connect' });
    });
  },
};

export const isLocal = new URLSearchParams(location.search).has('local');
export const transport = isLocal ? local : peerJs;
