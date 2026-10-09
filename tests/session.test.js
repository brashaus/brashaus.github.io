// End-to-end protocol test: one HostSession and two ClientSessions over an in-memory transport.
// Heartbeats are disabled (jsc has no setInterval); everything else is the real code.
globalThis.setInterval ??= () => 0;
globalThis.clearInterval ??= () => {};

const { Game } = await import('../js/game.js');
const { HostSession, ClientSession } = await import('../js/session.js');

const log = typeof print === 'function' ? print : console.log;
let failures = 0;
function check(cond, msg) {
  if (cond) log(`ok   ${msg}`);
  else { failures++; log(`FAIL ${msg}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const later = (fn) => setTimeout(fn, 1);
const copy = (x) => JSON.parse(JSON.stringify(x));

// In-memory transport with async, JSON-copied delivery like the real ones.
const rooms = new Map();
let seq = 0;
const memory = {
  openHost(code, h) {
    const peers = new Map();
    rooms.set(code, { h, peers });
    return Promise.resolve({
      send: (id, msg) => peers.get(id) && later(() => peers.get(id)?.onData(copy(msg))),
      close(id) {
        const peer = peers.get(id);
        if (!peer) return;
        peers.delete(id);
        later(() => peer.onClose());
        h.onPeerClose(id);
      },
      destroy() { rooms.delete(code); },
    });
  },
  connectClient(code, h) {
    const room = rooms.get(code);
    if (!room) return Promise.reject(Object.assign(new Error('notfound'), { type: 'notfound' }));
    const id = `m${++seq}`;
    room.peers.set(id, h);
    room.h.onPeer(id);
    return Promise.resolve({
      send: (msg) => room.peers.has(id) && later(() => room.h.onData(id, copy(msg))),
      destroy() {
        if (!room.peers.delete(id)) return;
        later(() => room.h.onPeerClose(id));
        h.onClose();
      },
    });
  },
};

const views = {};
const host = new HostSession({
  transport: memory,
  game: Game.create('host', 'Anna', { questions: ['Domanda di prova'] }),
  code: 'TEST1',
  save: () => {},
  onView: (v) => { views.host = v; },
  onError: (e) => log(`host error: ${e}`),
});
await host.open();

const ends = {};
function client(pid, name) {
  const c = new ClientSession({
    transport: memory, code: 'TEST1', playerId: pid, name,
    onView: (v) => { views[pid] = v; },
    onStatus: () => {},
    onError: (e) => log(`${pid} error: ${e}`),
    onEnd: (reason) => { ends[pid] = reason; },
  });
  c.connect();
  return c;
}
const bruno = client('b', 'Bruno');
const carla = client('c', 'Carla');
await tick(20);
check(views.b?.players.length === 3 && views.c?.players.length === 3, 'clients receive the lobby with 3 players');

const intruder = client('x', 'carla');
await tick(20);
check(ends.x === 'rejected', 'duplicate name is rejected');

host.dispatch({ type: 'settings', mode: 'simultaneous' });
host.dispatch({ type: 'start' });
await tick(20);
check(views.b.phase === 'answering' && views.b.question === 'Domanda di prova', 'clients see the question');

bruno.dispatch({ type: 'answer', text: 'segreto di Bruno' });
await tick(20);
check(!JSON.stringify(views.c).includes('segreto di Bruno'), 'answers do not leak before everyone answered');
check(views.c.answered.includes('b'), 'others see that Bruno answered');

// Carla reloads: same player id, new connection.
carla.close();
const carla2 = client('c', 'Carla');
await tick(20);
check(views.host.players.find((p) => p.id === 'c').connected, 'reloaded client gets its seat back');

carla2.dispatch({ type: 'answer', text: 'risposta di Carla' });
host.dispatch({ type: 'answer', text: 'risposta di Anna' });
await tick(20);
check(views.b.phase === 'guessing' && views.b.cards.length === 3, 'guessing starts when all answered');
check(views.b.cards.every((card) => card.authors.length === (card.mine ? 1 : 0)), 'authors hidden from clients');

const pick = (view) => Object.fromEntries(view.cards.filter((c) => !c.mine).map((c) => [c.id, [view.participants.find((id) => id !== view.me)]]));
bruno.dispatch({ type: 'submitGuesses', guesses: pick(views.b) });
carla2.dispatch({ type: 'submitGuesses', guesses: pick(views.c) });
host.dispatch({ type: 'submitGuesses', guesses: pick(views.host) });
await tick(20);
check(views.c.phase === 'results' && views.c.cards.every((card) => card.authors.length === card.count), 'results reveal every author');
const total = views.c.players.reduce((sum, p) => sum + p.score, 0);
check(total === 6, `3 players x 2 answers each = 6 points handed out (got ${total})`);

bruno.dispatch({ type: 'next' });
await tick(20);
check(views.b.phase === 'results', 'clients cannot drive host-only actions');

host.dispatch({ type: 'kick', playerId: 'b' });
await tick(400);
check(ends.b === 'kicked', 'kicked player is told so');
check(views.host.players.length === 2, 'kicked player removed');

host.close();
await tick(400);
check(ends.c === 'closed', 'closing the room notifies clients');

log(failures ? `\n${failures} test falliti` : '\nTutti i test passano');
