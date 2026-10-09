// Sessions glue the game to a transport. The host runs the Game and sends every player
// their own filtered view; clients only send actions and render what they receive.
//
// Wire protocol
//   client -> host: { t: 'hello', playerId, name } | { t: 'action', action } | { t: 'ping' }
//   host -> client: { t: 'view', view } | { t: 'error', message, fatal? } | { t: 'kicked' } | { t: 'closed' } | { t: 'ping' }

const PING_EVERY = 2000;
const STALE_AFTER = 7000;
const RETRY_EVERY = 2000;

export class HostSession {
  constructor({ transport, game, code, save, onView, onError }) {
    Object.assign(this, { transport, game, code, save, onView, onError });
    this.conns = new Map(); // connId -> { playerId, lastSeen }
  }

  async open() {
    this.link = await this.transport.openHost(this.code, {
      onPeer: (id) => this.conns.set(id, { playerId: null, lastSeen: Date.now() }),
      onData: (id, msg) => this.receive(id, msg),
      onPeerClose: (id) => this.dropConn(id),
    });
    this.timer = setInterval(() => this.heartbeat(), PING_EVERY);
    this.publish();
  }

  receive(connId, msg) {
    const conn = this.conns.get(connId);
    if (!conn || typeof msg !== 'object' || !msg) return;
    conn.lastSeen = Date.now();

    if (msg.t === 'hello') {
      const res = this.game.join(String(msg.playerId ?? ''), msg.name);
      if (res.error) {
        this.link.send(connId, { t: 'error', message: res.error, fatal: true });
        return;
      }
      // One live connection per seat: a reload replaces the old connection.
      for (const [otherId, other] of this.conns) {
        if (otherId !== connId && other.playerId === res.id) {
          other.playerId = null;
          this.link.close(otherId);
        }
      }
      conn.playerId = res.id;
      this.publish();
    } else if (msg.t === 'action' && conn.playerId) {
      this.apply(conn.playerId, msg.action, (message) => this.link.send(connId, { t: 'error', message }));
    }
  }

  // Actions from the host's own UI.
  dispatch(action) {
    this.apply(this.game.s.hostId, action, this.onError);
  }

  apply(playerId, action, reportError) {
    const res = this.game.handle(playerId, action);
    if (res.error) return reportError(res.error);
    if (res.kicked) {
      for (const [connId, conn] of this.conns) {
        if (conn.playerId !== res.kicked) continue;
        conn.playerId = null;
        this.link.send(connId, { t: 'kicked' });
        setTimeout(() => this.link.close(connId), 300);
      }
    }
    this.publish();
  }

  dropConn(connId) {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.conns.delete(connId);
    const stillHere = [...this.conns.values()].some((c) => c.playerId === conn.playerId);
    if (conn.playerId && !stillHere) {
      this.game.disconnect(conn.playerId);
      this.publish();
    }
  }

  heartbeat() {
    const now = Date.now();
    for (const [connId, conn] of this.conns) {
      if (now - conn.lastSeen > STALE_AFTER) this.link.close(connId);
      else this.link.send(connId, { t: 'ping' });
    }
  }

  publish() {
    this.save(this.game.s);
    for (const [connId, conn] of this.conns) {
      if (conn.playerId) this.link.send(connId, { t: 'view', view: this.game.viewFor(conn.playerId) });
    }
    this.onView(this.game.viewFor(this.game.s.hostId));
  }

  close() {
    clearInterval(this.timer);
    for (const connId of this.conns.keys()) this.link?.send(connId, { t: 'closed' });
    // Give the goodbye messages a moment to leave before tearing down.
    setTimeout(() => this.link?.destroy(), 300);
  }
}

// status: 'connecting' | 'online' | 'reconnecting'
export class ClientSession {
  constructor({ transport, code, playerId, name, onView, onStatus, onError, onEnd }) {
    Object.assign(this, { transport, code, playerId, name, onView, onStatus, onError, onEnd });
    this.everOnline = false;
    this.stopped = false;
  }

  async connect() {
    this.onStatus(this.everOnline ? 'reconnecting' : 'connecting');
    try {
      this.link = await this.transport.connectClient(this.code, {
        onData: (msg) => this.receive(msg),
        onClose: () => this.lost(),
      });
    } catch (err) {
      // Before the first successful connection a missing room is final; after that the host
      // may just be reloading, so keep trying.
      if (!this.everOnline && err.type === 'notfound') {
        this.stopped = true;
        this.onEnd('notfound');
      } else {
        this.retry();
      }
      return;
    }
    if (this.stopped) return this.link.destroy();
    this.lastSeen = Date.now();
    this.link.send({ t: 'hello', playerId: this.playerId, name: this.name });
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > STALE_AFTER) this.link.destroy();
      else this.link.send({ t: 'ping' });
    }, PING_EVERY);
  }

  receive(msg) {
    this.lastSeen = Date.now();
    if (msg.t === 'view') {
      if (!this.everOnline || this.status !== 'online') this.setOnline();
      this.playerId = msg.view.me;
      this.onView(msg.view);
    } else if (msg.t === 'error') {
      if (msg.fatal) this.stop('rejected', msg.message);
      else this.onError(msg.message);
    } else if (msg.t === 'kicked') {
      this.stop('kicked');
    } else if (msg.t === 'closed') {
      this.stop('closed');
    }
  }

  setOnline() {
    this.everOnline = true;
    this.status = 'online';
    this.onStatus('online');
  }

  lost() {
    clearInterval(this.timer);
    this.status = 'reconnecting';
    if (!this.stopped) this.retry();
  }

  retry() {
    if (this.stopped) return;
    this.onStatus('reconnecting');
    setTimeout(() => !this.stopped && this.connect(), RETRY_EVERY);
  }

  dispatch(action) {
    if (this.status === 'online') this.link.send({ t: 'action', action });
    else this.onError('Connessione persa, riprova tra un attimo.');
  }

  stop(reason, message) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.link?.destroy();
    this.onEnd(reason, message);
  }

  close() {
    this.stop('left');
  }
}
