// Pure game logic: no DOM, no network. Only the host holds a Game.
// State is plain JSON so the host can persist it and resume after a reload.

export const MIN_PLAYERS = 3;
export const MAX_NAME = 20;
export const MAX_ANSWER = 140;
export const SURVIVOR_BONUS = 2;
export const MODES = ['classic', 'simultaneous'];
export const ROUND_OPTIONS = [3, 5, 8, 10];

const fail = (error) => ({ error });
const OK = {};
const clone = (x) => JSON.parse(JSON.stringify(x));

export function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  constructor(state, { questions, rng = Math.random }) {
    this.s = state;
    this.s.history ??= []; // states saved before history existed
    this.questions = questions;
    this.rng = rng;
  }

  static create(hostId, hostName, opts) {
    const game = new Game({
      hostId,
      phase: 'lobby', // lobby | answering | guessing | results | end
      settings: { mode: 'classic', rounds: 5 },
      players: [],
      deck: [],
      roundNumber: 0,
      round: null,
      history: [], // finished rounds, for the host's download
    }, opts);
    game.join(hostId, hostName);
    return game;
  }

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  // Returns { id } of the seat the player got, which differs from the requested id
  // when they take back a disconnected seat with the same name (new tab or device).
  join(id, rawName) {
    const name = cleanName(rawName);
    if (!name) return fail('Scegli un nome.');
    const sameName = (p) => p.name.toLowerCase() === name.toLowerCase();
    const seat = this.player(id) ?? this.s.players.find((p) => !p.connected && sameName(p));
    if (seat) {
      seat.connected = true;
      return { id: seat.id };
    }
    if (this.s.players.some(sameName)) return fail('Questo nome è già in uso.');
    this.s.players.push({ id, name, score: 0, connected: true });
    return { id };
  }

  disconnect(id) {
    const p = this.player(id);
    if (p && id !== this.s.hostId) p.connected = false;
  }

  handle(pid, action) {
    if (!this.player(pid)) return fail('Non fai parte di questa partita.');
    const isHost = pid === this.s.hostId;
    const { phase, round } = this.s;
    const hostOnly = (fn) => (isHost ? fn() : fail("Solo l'host può farlo."));

    switch (action?.type) {
      case 'settings':
        return hostOnly(() => this.updateSettings(action));
      case 'start':
        return hostOnly(() => {
          if (phase !== 'lobby' && phase !== 'end') return fail('La partita è già iniziata.');
          if (this.s.players.filter((p) => p.connected).length < MIN_PLAYERS) {
            return fail(`Servono almeno ${MIN_PLAYERS} giocatori connessi.`);
          }
          for (const p of this.s.players) p.score = 0;
          this.s.roundNumber = 0;
          this.s.history = [];
          return this.startRound();
        });
      case 'next':
        return hostOnly(() => {
          if (phase !== 'results') return fail('Il round non è ancora finito.');
          if (this.s.roundNumber >= this.s.settings.rounds) {
            this.finishRound('end');
            return OK;
          }
          return this.startRound();
        });
      case 'endGame':
        return hostOnly(() => {
          if (phase === 'lobby') return fail('La partita non è ancora iniziata.');
          this.finishRound('end');
          return OK;
        });
      case 'backToLobby':
        return hostOnly(() => {
          if (phase !== 'end') return fail('Prima termina la partita.');
          this.s.phase = 'lobby';
          this.s.round = null;
          return OK;
        });
      case 'kick':
        return hostOnly(() => this.kick(action.playerId));
      case 'answer':
        return this.answer(pid, action.text);
      case 'newQuestion':
        return hostOnly(() => {
          if (phase !== 'answering') return fail('Si può cambiare domanda solo prima delle risposte.');
          round.question = this.drawQuestion();
          round.answers = {};
          return OK;
        });
      case 'forceAdvance':
        return hostOnly(() => this.forceAdvance());
      case 'guess':
        return this.guess(pid, action.cardId, action.suspectId);
      case 'skipTurn':
        return hostOnly(() => {
          if (phase !== 'guessing' || !round.classic) return fail('Non è il momento.');
          const c = round.classic;
          c.log.push({ guesser: c.turn, skipped: true });
          c.turn = this.nextTurn(c.turn);
          return OK;
        });
      case 'submitGuesses':
        return this.submitGuesses(pid, action.guesses);
      default:
        return fail('Azione sconosciuta.');
    }
  }

  updateSettings({ mode, rounds }) {
    if (this.s.phase !== 'lobby') return fail('Le impostazioni si cambiano nella lobby.');
    if (mode !== undefined) {
      if (!MODES.includes(mode)) return fail('Modalità non valida.');
      this.s.settings.mode = mode;
    }
    if (rounds !== undefined) {
      if (!ROUND_OPTIONS.includes(rounds)) return fail('Numero di round non valido.');
      this.s.settings.rounds = rounds;
    }
    return OK;
  }

  kick(id) {
    if (!['lobby', 'results', 'end'].includes(this.s.phase)) {
      return fail('Puoi rimuovere giocatori solo tra un round e l’altro.');
    }
    if (id === this.s.hostId) return fail('Non puoi rimuovere te stesso.');
    if (!this.player(id)) return fail('Giocatore non trovato.');
    this.s.players = this.s.players.filter((p) => p.id !== id);
    return { kicked: id };
  }

  drawQuestion() {
    if (this.s.deck.length === 0) {
      this.s.deck = shuffle(this.questions.map((_, i) => i), this.rng);
    }
    return this.questions[this.s.deck.pop()];
  }

  startRound() {
    const participants = this.s.players.filter((p) => p.connected).map((p) => p.id);
    if (participants.length < MIN_PLAYERS) {
      return fail(`Servono almeno ${MIN_PLAYERS} giocatori connessi.`);
    }
    this.s.roundNumber += 1;
    this.s.round = {
      question: this.drawQuestion(),
      mode: this.s.settings.mode,
      participants,
      answers: {},
      deltas: {},
    };
    this.s.phase = 'answering';
    return OK;
  }

  answer(pid, raw) {
    const r = this.s.round;
    if (this.s.phase !== 'answering') return fail('Non è il momento di rispondere.');
    if (!r.participants.includes(pid)) return fail('Entrerai in gioco dal prossimo round.');
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER);
    if (!text) return fail('Scrivi una risposta.');
    r.answers[pid] = text;
    if (r.participants.every((id) => id in r.answers)) this.startGuessing();
    return OK;
  }

  forceAdvance() {
    const r = this.s.round;
    if (this.s.phase === 'answering') {
      const answered = r.participants.filter((id) => id in r.answers);
      if (answered.length < MIN_PLAYERS) return fail(`Servono almeno ${MIN_PLAYERS} risposte.`);
      r.participants = answered;
      this.startGuessing();
      return OK;
    }
    if (this.s.phase === 'guessing' && r.simul) {
      this.scoreSimultaneous();
      return OK;
    }
    return fail('Non è il momento.');
  }

  startGuessing() {
    const r = this.s.round;
    // Answers that differ only in letter case become one card with several authors.
    const byText = new Map();
    for (const author of shuffle(r.participants, this.rng)) {
      const key = r.answers[author].toLocaleLowerCase('it');
      if (byText.has(key)) byText.get(key).authors.push(author);
      else byText.set(key, { text: r.answers[author], authors: [author] });
    }
    r.cards = [...byText.values()].map((card, i) => ({ id: `c${i}`, ...card }));
    if (r.mode === 'classic') {
      const first = r.participants[(this.s.roundNumber - 1) % r.participants.length];
      r.classic = { turn: first, eliminated: [], log: [], survivor: null };
    } else {
      r.simul = { guesses: {} };
    }
    this.s.phase = 'guessing';
  }

  award(pid, points) {
    const r = this.s.round;
    r.deltas[pid] = (r.deltas[pid] ?? 0) + points;
    const p = this.player(pid);
    if (p) p.score += points;
  }

  nextTurn(from) {
    const { participants } = this.s.round;
    const { eliminated } = this.s.round.classic;
    const start = participants.indexOf(from);
    for (let k = 1; k <= participants.length; k++) {
      const id = participants[(start + k) % participants.length];
      if (!eliminated.includes(id)) return id;
    }
    return from;
  }

  guess(pid, cardId, suspectId) {
    const r = this.s.round;
    if (this.s.phase !== 'guessing' || !r.classic) return fail('Non è il momento.');
    const c = r.classic;
    if (pid !== c.turn) return fail('Non è il tuo turno.');
    const card = r.cards.find((x) => x.id === cardId);
    // Your own card is fair game too if somebody else wrote the same thing.
    const hidden = card?.authors.filter((a) => a !== pid && !c.eliminated.includes(a)) ?? [];
    if (hidden.length === 0) return fail('Scegli una risposta con un autore ancora da scoprire.');
    if (!r.participants.includes(suspectId) || suspectId === pid || c.eliminated.includes(suspectId)) {
      return fail('Scegli un giocatore ancora in gioco.');
    }
    const correct = card.authors.includes(suspectId);
    c.log.push({ guesser: pid, cardId, suspect: suspectId, correct });
    if (!correct) {
      c.turn = this.nextTurn(pid);
      return OK;
    }
    // A right guess scores and lets the same player keep guessing.
    c.eliminated.push(suspectId);
    this.award(pid, 1);
    const alive = r.participants.filter((id) => !c.eliminated.includes(id));
    if (alive.length <= 1) {
      c.survivor = alive[0] ?? null;
      if (c.survivor) this.award(c.survivor, SURVIVOR_BONUS);
      this.finishRound();
    }
    return OK;
  }

  submitGuesses(pid, guesses) {
    const r = this.s.round;
    if (this.s.phase !== 'guessing' || !r.simul) return fail('Non è il momento.');
    if (!r.participants.includes(pid)) return fail('Non partecipi a questo round.');
    const clean = {};
    for (const card of r.cards) {
      const needed = card.authors.filter((a) => a !== pid).length;
      if (needed === 0) continue;
      const picks = guesses?.[card.id];
      const valid = Array.isArray(picks) && picks.length === needed && new Set(picks).size === needed
        && picks.every((id) => id !== pid && r.participants.includes(id));
      if (!valid) return fail('Assegna gli autori a ogni risposta.');
      clean[card.id] = [...picks];
    }
    r.simul.guesses[pid] = clean;
    if (r.participants.every((id) => id in r.simul.guesses)) this.scoreSimultaneous();
    return OK;
  }

  // For every author of every card: +1 to each player who named them,
  // and +1 to the author for each player who did not.
  // correct[cardId][authorId] lists who found that author.
  scoreSimultaneous() {
    const r = this.s.round;
    r.simul.correct = {};
    for (const card of r.cards) {
      const found = {};
      for (const author of card.authors) {
        found[author] = [];
        for (const [guesser, guesses] of Object.entries(r.simul.guesses)) {
          if (guesser === author) continue;
          if (guesses[card.id]?.includes(author)) {
            found[author].push(guesser);
            this.award(guesser, 1);
          } else {
            this.award(author, 1);
          }
        }
      }
      r.simul.correct[card.id] = found;
    }
    this.finishRound();
  }

  // Ends the round and archives it. A game ended mid-round keeps that round only if answers were in.
  finishRound(phase = 'results') {
    const r = this.s.round;
    if (r?.cards && !r.archived) {
      r.archived = true;
      this.s.history.push({
        number: this.s.roundNumber,
        question: r.question,
        answers: r.cards.map((c) => ({ text: c.text, authors: c.authors.map((id) => this.player(id)?.name ?? '?') })),
      });
    }
    this.s.phase = phase;
  }

  // Every finished round with its authors, plus the scores. Host only: it reveals everything.
  transcript() {
    return {
      rounds: clone(this.s.history),
      scores: [...this.s.players].sort((a, b) => b.score - a.score).map(({ name, score }) => ({ name, score })),
    };
  }

  // What one player is allowed to see. Authors stay hidden until they are revealed.
  viewFor(pid) {
    const { s } = this;
    const r = s.round;
    const view = {
      me: pid,
      hostId: s.hostId,
      phase: s.phase,
      settings: { ...s.settings },
      roundNumber: s.roundNumber,
      players: s.players.map(({ id, name, score, connected }) => ({ id, name, score, connected })),
    };
    if (!r || s.phase === 'lobby') return view;

    view.question = r.question;
    view.mode = r.mode;
    view.participants = [...r.participants];
    view.deltas = s.phase === 'answering' ? {} : { ...r.deltas };

    if (s.phase === 'answering') {
      view.answered = r.participants.filter((id) => id in r.answers);
      view.myAnswer = r.answers[pid] ?? null;
      return view;
    }
    if (!r.cards) return view; // game ended during the answering phase

    const revealAll = s.phase !== 'guessing';
    const eliminated = r.classic?.eliminated ?? [];
    // `count` is public (a shared answer is a clue), `authors` only lists the ones already revealed to pid.
    view.cards = r.cards.map((c) => ({
      id: c.id,
      text: c.text,
      count: c.authors.length,
      mine: c.authors.includes(pid),
      authors: revealAll ? [...c.authors] : c.authors.filter((a) => a === pid || eliminated.includes(a)),
    }));
    if (r.classic) {
      view.classic = {
        turn: r.classic.turn,
        eliminated: [...eliminated],
        log: r.classic.log.map((e) => ({ ...e })),
        survivor: r.classic.survivor,
      };
    }
    if (r.simul) {
      view.simul = {
        submitted: Object.keys(r.simul.guesses),
        myGuesses: r.simul.guesses[pid] ? clone(r.simul.guesses[pid]) : null,
      };
      if (revealAll) {
        view.simul.correct = r.simul.correct ? clone(r.simul.correct) : {};
        view.simul.guesses = clone(r.simul.guesses);
      }
    }
    return view;
  }
}
