// Run with: ./tests/run.sh  (uses macOS JavaScriptCore, no Node needed)
import { Game, SURVIVOR_BONUS } from '../js/game.js';

let failures = 0;
const log = typeof print === 'function' ? print : console.log;
function test(name, fn) {
  try {
    fn();
    log(`ok   ${name}`);
  } catch (e) {
    failures++;
    log(`FAIL ${name}\n     ${e.message}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(value, msg = 'expected truthy') {
  if (!value) throw new Error(msg);
}

function seeded(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function setup(mode = 'classic', names = ['Anna', 'Bruno', 'Carla']) {
  const g = Game.create('a', names[0], { questions: ['Q1', 'Q2', 'Q3'], rng: seeded(7) });
  names.slice(1).forEach((n, i) => g.join(String.fromCharCode(98 + i), n));
  g.handle('a', { type: 'settings', mode });
  return g;
}
const ids = (g) => g.s.players.map((p) => p.id);
function answerAll(g) {
  for (const id of g.s.round.participants) eq(g.handle(id, { type: 'answer', text: `risposta di ${id}` }), {});
}
const authorOf = (g, cardId) => g.s.round.cards.find((c) => c.id === cardId).author;
const cardOf = (g, author) => g.s.round.cards.find((c) => c.author === author).id;

test('needs 3 connected players to start', () => {
  const g = setup('classic', ['Anna', 'Bruno']);
  ok(g.handle('a', { type: 'start' }).error);
  g.join('c', 'Carla');
  eq(g.handle('a', { type: 'start' }), {});
  eq(g.s.phase, 'answering');
});

test('only the host can start or change settings', () => {
  const g = setup();
  ok(g.handle('b', { type: 'start' }).error);
  ok(g.handle('b', { type: 'settings', mode: 'simultaneous' }).error);
  ok(g.handle('a', { type: 'settings', rounds: 4 }).error, 'invalid rounds');
});

test('names must be unique, rejoin takes back a disconnected seat', () => {
  const g = setup();
  ok(g.join('x', 'anna ').error);
  g.disconnect('b');
  eq(g.join('new-tab', 'bruno'), { id: 'b' });
  eq(g.player('b').connected, true);
  eq(g.join('c', 'Carla'), { id: 'c' }, 'same id rejoins');
});

test('answers stay hidden until everybody answered', () => {
  const g = setup();
  g.handle('a', { type: 'start' });
  g.handle('a', { type: 'answer', text: 'segreto' });
  const v = g.viewFor('b');
  eq(v.answered, ['a']);
  eq(v.myAnswer, null);
  ok(!JSON.stringify(v).includes('segreto'), 'answer text leaked');
  g.handle('b', { type: 'answer', text: 'x' });
  eq(g.s.phase, 'answering');
  g.handle('c', { type: 'answer', text: 'y' });
  eq(g.s.phase, 'guessing');
});

test('guessing view hides authors except your own', () => {
  const g = setup();
  g.handle('a', { type: 'start' });
  answerAll(g);
  const v = g.viewFor('b');
  eq(v.cards.length, 3);
  for (const c of v.cards) eq(c.author, c.mine ? 'b' : null);
});

test('classic: wrong guess passes turn, right guess scores and continues', () => {
  const g = setup();
  g.handle('a', { type: 'start' });
  answerAll(g);
  eq(g.s.round.classic.turn, 'a');
  ok(g.handle('b', { type: 'guess', cardId: cardOf(g, 'c'), suspectId: 'c' }).error, 'not your turn');
  ok(g.handle('a', { type: 'guess', cardId: cardOf(g, 'a'), suspectId: 'b' }).error, 'own card');

  g.handle('a', { type: 'guess', cardId: cardOf(g, 'b'), suspectId: 'c' });
  eq(g.s.round.classic.turn, 'b', 'wrong guess passes turn');

  g.handle('b', { type: 'guess', cardId: cardOf(g, 'c'), suspectId: 'c' });
  eq(g.s.round.classic.eliminated, ['c']);
  eq(g.s.round.classic.turn, 'b', 'right guess keeps turn');
  const v = g.viewFor('a');
  eq(v.cards.find((c) => c.id === cardOf(g, 'c')).author, 'c', 'eliminated author revealed');
  eq(v.cards.find((c) => c.id === cardOf(g, 'b')).author, null);

  g.handle('b', { type: 'guess', cardId: cardOf(g, 'a'), suspectId: 'a' });
  eq(g.s.phase, 'results');
  eq(g.s.round.classic.survivor, 'b');
  eq(g.player('b').score, 2 + SURVIVOR_BONUS);
  eq(g.player('a').score, 0);
});

test('classic: eliminated players are skipped and skipTurn works', () => {
  const g = setup('classic', ['Anna', 'Bruno', 'Carla', 'Dario']);
  g.handle('a', { type: 'start' });
  answerAll(g);
  g.handle('a', { type: 'guess', cardId: cardOf(g, 'b'), suspectId: 'b' });
  g.handle('a', { type: 'guess', cardId: cardOf(g, 'c'), suspectId: 'd' });
  eq(g.s.round.classic.turn, 'c', 'b is eliminated so c is next');
  ok(g.handle('c', { type: 'guess', cardId: cardOf(g, 'd'), suspectId: 'b' }).error, 'cannot suspect eliminated');
  g.handle('a', { type: 'skipTurn' });
  eq(g.s.round.classic.turn, 'd');
});

test('simultaneous: scoring for guessers and fooling authors', () => {
  const g = setup('simultaneous');
  g.handle('a', { type: 'start' });
  answerAll(g);
  ok(g.handle('a', { type: 'submitGuesses', guesses: { [cardOf(g, 'b')]: 'b' } }).error, 'incomplete');
  // a gets both right, b gets both wrong, c gets one right.
  g.handle('a', { type: 'submitGuesses', guesses: { [cardOf(g, 'b')]: 'b', [cardOf(g, 'c')]: 'c' } });
  g.handle('b', { type: 'submitGuesses', guesses: { [cardOf(g, 'a')]: 'c', [cardOf(g, 'c')]: 'a' } });
  const mid = g.viewFor('c');
  eq(mid.simul.submitted, ['a', 'b']);
  eq(mid.simul.guesses, undefined, 'others guesses hidden');
  g.handle('c', { type: 'submitGuesses', guesses: { [cardOf(g, 'a')]: 'a', [cardOf(g, 'b')]: 'a' } });
  eq(g.s.phase, 'results');
  // a: 2 right + fooled b = 3; b: 0 right + fooled c = 1;
  // c: 1 right + fooled b = 2
  eq(g.s.round.deltas, { a: 3, b: 1, c: 2 });
  eq(g.viewFor('b').cards.every((c) => c.author), true, 'results reveal all');
});

test('forceAdvance drops players who did not answer', () => {
  const g = setup('classic', ['Anna', 'Bruno', 'Carla', 'Dario']);
  g.handle('a', { type: 'start' });
  g.handle('a', { type: 'answer', text: '1' });
  g.handle('b', { type: 'answer', text: '2' });
  ok(g.handle('a', { type: 'forceAdvance' }).error, 'needs 3 answers');
  g.handle('c', { type: 'answer', text: '3' });
  eq(g.handle('a', { type: 'forceAdvance' }), {});
  eq(g.s.round.participants, ['a', 'b', 'c']);
  eq(g.s.phase, 'guessing');
});

test('players joining mid-round wait for the next round', () => {
  const g = setup();
  g.handle('a', { type: 'start' });
  g.join('d', 'Dario');
  ok(g.handle('d', { type: 'answer', text: 'ciao' }).error);
  answerAll(g);
  eq(g.viewFor('d').cards.length, 3);
});

test('rounds advance to the end and restart resets scores', () => {
  const g = setup('simultaneous');
  g.handle('a', { type: 'settings', rounds: 3 });
  g.handle('a', { type: 'start' });
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    seen.add(g.s.round.question);
    answerAll(g);
    g.handle('a', { type: 'forceAdvance' });
    eq(g.s.phase, 'results');
    g.handle('a', { type: 'next' });
  }
  eq(seen.size, 3, 'no repeated questions');
  eq(g.s.phase, 'end');
  g.player('a').score = 5;
  g.handle('a', { type: 'start' });
  eq(g.player('a').score, 0);
  eq(g.s.roundNumber, 1);
});

test('kick only between rounds', () => {
  const g = setup();
  g.join('d', 'Dario');
  eq(g.handle('a', { type: 'kick', playerId: 'd' }), { kicked: 'd' });
  g.handle('a', { type: 'start' });
  ok(g.handle('a', { type: 'kick', playerId: 'c' }).error);
  ok(g.handle('b', { type: 'kick', playerId: 'c' }).error);
});

test('state survives a JSON round trip', () => {
  const g = setup();
  g.handle('a', { type: 'start' });
  answerAll(g);
  const g2 = new Game(JSON.parse(JSON.stringify(g.s)), { questions: g.questions, rng: seeded(3) });
  eq(g2.viewFor('b'), g.viewFor('b'));
});

log(failures ? `\n${failures} test falliti` : '\nTutti i test passano');
