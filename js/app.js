import { Game, MIN_PLAYERS, MAX_NAME, MAX_ANSWER, ROUND_OPTIONS, SURVIVOR_BONUS, cleanName } from './game.js';
import { QUESTIONS } from './questions.js';
import { HostSession, ClientSession } from './session.js';
import { transport, isLocal } from './transport.js';

const APP_NAME = 'Brashaus';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const HOST_STATE_TTL = 24 * 60 * 60 * 1000;

const MODE_INFO = {
  classic: {
    title: 'Classica',
    text: 'A turno si indovina l’autore di una risposta. Chi indovina prende 1 punto e rigioca, chi viene scoperto è fuori. '
      + `L’ultimo rimasto prende ${SURVIVOR_BONUS} punti bonus.`,
  },
  simultaneous: {
    title: 'Simultanea',
    text: 'Tutti abbinano ogni risposta al suo autore nello stesso momento. 1 punto per ogni abbinamento giusto, '
      + 'e 1 punto all’autore per ogni giocatore che non l’ha indovinato.',
  },
};

// --- Storage (may be unavailable, e.g. private mode) -----------------------------------------

function storage(kind) {
  try {
    return window[kind];
  } catch {
    return null;
  }
}
const local = storage('localStorage');
const session = storage('sessionStorage');
function load(area, key) {
  try {
    return JSON.parse(area?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
function save(area, key, value) {
  try {
    if (value == null) area?.removeItem(key);
    else area?.setItem(key, JSON.stringify(value));
  } catch { /* storage full or blocked: the game still works, only resume is lost */ }
}

const KEY_NAME = 'bh.name';
const KEY_PID = 'bh.pid'; // per tab, so several tabs in one browser are different players
const KEY_ROLE = 'bh.role';
const hostKey = (code) => `bh.host.${code}`;

function myPid() {
  let pid = load(session, KEY_PID);
  if (!pid) {
    pid = crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    save(session, KEY_PID, pid);
  }
  return pid;
}

function savedHost(code) {
  const saved = load(local, hostKey(code));
  return saved && Date.now() - saved.savedAt < HOST_STATE_TTL ? saved.state : null;
}

function pruneSavedHosts() {
  if (!local) return;
  for (let i = local.length - 1; i >= 0; i--) {
    const key = local.key(i);
    if (key?.startsWith('bh.host.') && !savedHost(key.slice('bh.host.'.length))) local.removeItem(key);
  }
}

// --- Tiny DOM helper --------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'key') el.dataset.key = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const AVATAR_COLORS = ['#4a7c59', '#4c7a77', '#6b7a3e', '#93763f', '#4f6d85', '#9a4f5a', '#6c5a8a', '#9a6444'];
function avatar(view, id) {
  const index = view.players.findIndex((p) => p.id === id);
  const name = nameOf(view, id);
  return h('span', { class: 'avatar', style: `background:${AVATAR_COLORS[index % AVATAR_COLORS.length] ?? '#999'}` },
    name.slice(0, 1).toUpperCase());
}

function nameOf(view, id) {
  return view.players.find((p) => p.id === id)?.name ?? 'Qualcuno';
}

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

function shareUrl(code) {
  return `${location.origin}${location.pathname}${location.search}#${code}`;
}

async function copyLink(code) {
  const url = shareUrl(code);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: APP_NAME, text: `Entra nella mia stanza: ${code}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('Link copiato!');
  } catch (err) {
    if (err?.name !== 'AbortError') prompt('Copia questo link:', url);
  }
}

// --- App state --------------------------------------------------------------------------------

const app = {
  screen: 'home', // home | connecting | game
  connectingText: '',
  homeError: '',
  resumeOffer: null, // room code we could reopen as host
  prefillCode: '',
  session: null,
  isHost: false,
  code: '',
  view: null,
  lastViewJson: '',
};

const freshUi = () => ({
  round: -1, question: null, answerDraft: '', editingAnswer: false,
  card: null, suspect: null, logLength: 0, guessDraft: {}, editingGuesses: false,
});
let ui = freshUi();

function syncUi(view) {
  if (view.roundNumber !== ui.round) ui = { ...freshUi(), round: view.roundNumber };
  if (view.question !== ui.question) {
    ui.question = view.question;
    ui.answerDraft = '';
    ui.editingAnswer = false;
  }
  const logLength = view.classic?.log.length ?? 0;
  if (logLength !== ui.logLength) {
    ui.logLength = logLength;
    ui.card = null;
    ui.suspect = null;
  }
}

function dispatch(action) {
  app.session?.dispatch(action);
}

function setHash(code) {
  history.replaceState(null, '', code ? `#${code}` : location.pathname + location.search);
}

// --- Rendering ----------------------------------------------------------------------------------

const root = document.getElementById('app');

function render() {
  // Keep focus, caret and scroll across full re-renders.
  const active = document.activeElement?.dataset?.key;
  const selection = active && 'selectionStart' in document.activeElement
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scroll = window.scrollY;

  root.replaceChildren(
    app.screen === 'home' ? renderHome()
      : app.screen === 'connecting' ? renderConnecting()
        : renderGame(app.view),
  );

  if (active) {
    const el = root.querySelector(`[data-key="${active}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection && el.setSelectionRange) {
        try { el.setSelectionRange(...selection); } catch { /* not a text field */ }
      }
    }
  }
  window.scrollTo(0, scroll);
}

function renderStatus(status) {
  const el = document.getElementById('status');
  el.hidden = status !== 'reconnecting';
  el.textContent = 'Connessione persa, mi ricollego…';
}

function renderHome() {
  const name = load(local, KEY_NAME) ?? '';
  const nameInput = h('input', {
    key: 'name', value: name, maxlength: MAX_NAME, placeholder: 'Es. Giulia', autocomplete: 'nickname',
    oninput: (e) => save(local, KEY_NAME, e.target.value),
  });
  const codeInput = h('input', {
    key: 'code', class: 'code-input', value: app.prefillCode, maxlength: CODE_LENGTH, placeholder: 'ABCDE',
    autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => { app.prefillCode = e.target.value.toUpperCase(); },
    onkeydown: (e) => e.key === 'Enter' && join(),
  });

  const readName = () => {
    const n = cleanName(nameInput.value);
    if (!n) {
      app.homeError = 'Prima scegli un nome!';
      render();
      root.querySelector('[data-key="name"]').focus();
    }
    return n;
  };
  const create = () => {
    const n = readName();
    if (n) createRoom(n);
  };
  const join = () => {
    const n = readName();
    const code = codeInput.value.trim().toUpperCase();
    if (!n) return;
    if (code.length !== CODE_LENGTH) {
      app.homeError = `Il codice della stanza ha ${CODE_LENGTH} caratteri.`;
      return render();
    }
    joinRoom(code, n);
  };

  const invited = Boolean(app.prefillCode) && app.prefillCode.length === CODE_LENGTH && !app.homeError;

  return h('div', { class: 'stack' },
    h('div', { class: 'hero' },
      h('h1', null, APP_NAME),
      h('p', { class: 'muted' }, 'Rispondi in segreto. Poi scopri chi ha scritto cosa.'),
      isLocal && h('span', { class: 'badge' }, 'modalità locale'),
    ),
    h('div', { class: 'panel stack' },
      h('div', null, h('label', null, 'Il tuo nome'), nameInput),
      app.homeError && h('p', { class: 'error' }, app.homeError),
      app.resumeOffer && h('button', { class: 'primary big', onclick: () => resumeHost(app.resumeOffer) },
        `Riapri la stanza ${app.resumeOffer} come host`),
      invited
        ? [
          h('p', null, 'Stai entrando nella stanza ', h('strong', null, app.prefillCode)),
          h('button', { class: 'primary big', onclick: join }, 'Entra'),
        ]
        : [
          h('button', { class: 'primary big', onclick: create }, 'Crea una stanza'),
          h('div', { class: 'divider' }, 'oppure entra con un codice'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, codeInput), h('button', { onclick: join }, 'Entra')),
        ],
    ),
    h('div', { class: 'panel' },
      h('h3', null, 'Come si gioca'),
      h('p', null, 'Ogni round esce una domanda. Tutti rispondono in segreto: le risposte compaiono solo quando hanno risposto tutti.'),
      h('p', { class: 'muted' }, `Poi bisogna indovinare chi ha scritto cosa. Servono almeno ${MIN_PLAYERS} giocatori, ognuno col suo telefono.`),
    ),
  );
}

function renderConnecting() {
  return h('div', { class: 'center' },
    h('div', { class: 'spinner' }),
    h('p', null, app.connectingText),
    h('button', { class: 'ghost', onclick: () => endSession('left') }, 'Annulla'),
  );
}

function renderGame(view) {
  if (!view) return renderConnecting();
  syncUi(view);
  const isHost = view.me === view.hostId;
  const inGame = !['lobby', 'end'].includes(view.phase);

  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'chip code', title: 'Copia il link d’invito', onclick: () => copyLink(app.code) }, app.code),
    inGame && h('span', { class: 'chip' }, `Round ${view.roundNumber}/${view.settings.rounds}`),
    isLocal && h('span', { class: 'badge' }, 'locale'),
    h('span', { class: 'grow' }),
    h('button', { class: 'ghost small', onclick: leave }, 'Esci'),
  );

  const screens = {
    lobby: renderLobby,
    answering: renderAnswering,
    guessing: view.mode === 'classic' ? renderClassic : renderSimultaneous,
    results: renderResults,
    end: renderEnd,
  };
  const body = screens[view.phase](view, isHost);

  const endButton = isHost && inGame && h('button', {
    class: 'ghost small danger',
    onclick: () => confirm('Terminare la partita adesso?') && dispatch({ type: 'endGame' }),
  }, 'Termina partita');

  return h('div', null, topbar, h('div', { class: 'stack' }, body, endButton && h('div', { class: 'center' }, endButton)));
}

function renderPlayers(view, { showScore = false, canKick = false, extra } = {}) {
  const players = showScore ? [...view.players].sort((a, b) => b.score - a.score) : view.players;
  return h('ul', { class: 'players' }, players.map((p) =>
    h('li', { class: p.connected ? '' : 'offline' },
      avatar(view, p.id),
      h('span', { class: 'name' }, p.name,
        p.id === view.me && h('span', { class: 'tag' }, 'tu'),
        p.id === view.hostId && h('span', { class: 'tag' }, 'host'),
        !p.connected && h('span', { class: 'tag' }, 'offline')),
      extra?.(p),
      showScore && h('span', { class: 'score' }, p.score),
      canKick && p.id !== view.me && h('button', {
        class: 'ghost small', title: 'Rimuovi',
        onclick: () => confirm(`Rimuovere ${p.name} dalla stanza?`) && dispatch({ type: 'kick', playerId: p.id }),
      }, 'Rimuovi'),
    )));
}

function renderLobby(view, isHost) {
  const connected = view.players.filter((p) => p.connected).length;
  const missing = Math.max(0, MIN_PLAYERS - connected);
  const { mode, rounds } = view.settings;

  return [
    h('div', { class: 'panel center' },
      h('h3', null, 'Codice della stanza'),
      h('div', { class: 'room-code' }, app.code),
      h('button', { class: 'primary', onclick: () => copyLink(app.code) }, 'Invita gli amici'),
    ),
    h('div', { class: 'panel' },
      h('h3', null, `Giocatori (${view.players.length})`),
      renderPlayers(view, { canKick: isHost }),
    ),
    h('div', { class: 'panel stack' },
      h('h3', null, 'Modalità'),
      h('div', { class: 'options' }, Object.entries(MODE_INFO).map(([key, info]) =>
        h('button', {
          class: `option${mode === key ? ' selected' : ''}`,
          disabled: !isHost,
          onclick: () => dispatch({ type: 'settings', mode: key }),
        }, h('strong', null, info.title), h('span', null, info.text)))),
      h('h3', null, 'Round'),
      h('div', { class: 'segmented' }, ROUND_OPTIONS.map((n) =>
        h('button', {
          class: rounds === n ? 'selected' : '',
          disabled: !isHost,
          onclick: () => dispatch({ type: 'settings', rounds: n }),
        }, String(n)))),
    ),
    isHost
      ? h('button', { class: 'primary big', disabled: missing > 0, onclick: () => dispatch({ type: 'start' }) },
        missing > 0 ? `Mancano ${missing} giocator${missing === 1 ? 'e' : 'i'}` : 'Inizia la partita!')
      : h('p', { class: 'center muted' }, 'In attesa che l’host avvii la partita…'),
  ];
}

function questionCard(view) {
  return h('div', { class: 'question' }, h('small', null, `Round ${view.roundNumber}`), view.question);
}

function renderAnswering(view, isHost) {
  const inRound = view.participants.includes(view.me);
  const answered = view.myAnswer != null;
  const waitingFor = view.participants.filter((id) => !view.answered.includes(id));

  let mine;
  if (!inRound) {
    mine = h('p', { class: 'panel center' }, 'Il round è già iniziato: entrerai in gioco dal prossimo.');
  } else if (answered && !ui.editingAnswer) {
    mine = h('div', { class: 'panel stack' },
      h('h3', null, 'La tua risposta'),
      h('p', null, view.myAnswer),
      h('button', { class: 'small', onclick: () => { ui.editingAnswer = true; ui.answerDraft = view.myAnswer; render(); } }, 'Modifica'),
    );
  } else {
    const send = () => {
      const text = ui.answerDraft.trim();
      if (!text) return toast('Scrivi qualcosa!');
      ui.editingAnswer = false;
      dispatch({ type: 'answer', text });
    };
    mine = h('div', { class: 'panel stack' },
      h('textarea', {
        key: 'answer', maxlength: MAX_ANSWER, placeholder: 'Scrivi la tua risposta…', value: ui.answerDraft,
        oninput: (e) => { ui.answerDraft = e.target.value; },
        onkeydown: (e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send()),
      }),
      h('button', { class: 'primary big', onclick: send }, answered ? 'Aggiorna risposta' : 'Invia'),
      h('p', { class: 'hint' }, 'Nessuno vedrà le risposte finché non avranno risposto tutti.'),
    );
  }

  return [
    questionCard(view),
    mine,
    h('div', { class: 'panel' },
      h('h3', null, `Risposte: ${view.answered.length}/${view.participants.length}`),
      renderPlayers({ ...view, players: view.players.filter((p) => view.participants.includes(p.id)) }, {
        extra: (p) => (view.answered.includes(p.id)
          ? h('span', { class: 'check' }, 'fatto')
          : h('span', { class: 'waiting-dot' }, 'sta scrivendo…')),
      }),
    ),
    isHost && h('div', { class: 'host-bar row' },
      h('button', { class: 'small', onclick: () => dispatch({ type: 'newQuestion' }) }, 'Cambia domanda'),
      waitingFor.length > 0 && view.answered.length >= MIN_PLAYERS && h('button', {
        class: 'small',
        onclick: () => confirm('Andare avanti senza chi non ha ancora risposto?') && dispatch({ type: 'forceAdvance' }),
      }, 'Vai avanti senza chi manca'),
    ),
  ];
}

function joinNames(view, ids) {
  const names = ids.map((id) => nameOf(view, id));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

function answerCard(view, card, { onclick, selected, meta, extra } = {}) {
  // In classic mode a card is struck through once all of its authors are known (your own solo card excluded).
  const solved = view.phase === 'guessing' && view.classic && card.authors.length === card.count;
  const revealed = solved && !(card.mine && card.count === 1);
  const cls = ['answer',
    card.mine && 'mine', revealed && 'revealed', onclick && 'selectable', selected && 'selected'].filter(Boolean).join(' ');
  return h(onclick ? 'button' : 'div', { class: cls, onclick },
    card.count > 1 && h('span', { class: 'shared' }, `Scritta da ${card.count}`),
    h('span', { class: 'text' }, card.text),
    meta && h('span', { class: 'meta' }, meta),
    extra,
  );
}

function lastEvent(view) {
  const e = view.classic.log.at(-1);
  if (!e) return null;
  const guesser = nameOf(view, e.guesser);
  if (e.skipped) return h('div', { class: 'event' }, `Turno di ${guesser} saltato.`);
  const card = view.cards.find((c) => c.id === e.cardId);
  return h('div', { class: `event ${e.correct ? 'good' : 'bad'}` },
    `${guesser} pensa che «${card?.text ?? '…'}» sia di ${nameOf(view, e.suspect)}: `,
    h('strong', null, e.correct ? 'giusto!' : 'sbagliato.'));
}

function renderClassic(view, isHost) {
  const { turn, eliminated } = view.classic;
  const myTurn = turn === view.me;
  const alive = view.participants.filter((id) => !eliminated.includes(id));
  const suspects = alive.filter((id) => id !== view.me);

  const cards = view.cards.map((card) => {
    const found = card.authors.filter((id) => id !== view.me);
    const hidden = card.count - card.authors.length;
    const meta = [
      card.mine && 'La tua risposta',
      found.length > 0 && `${card.count > 1 ? 'Di' : 'Era di'} ${joinNames(view, found)}`,
      card.count > 1 && hidden > 0 && `${hidden} da scoprire`,
    ].filter(Boolean).join(' · ');
    const pickable = myTurn && hidden > 0;
    return answerCard(view, card, {
      meta,
      selected: ui.card === card.id,
      onclick: pickable ? () => { ui.card = ui.card === card.id ? null : card.id; ui.suspect = null; render(); } : null,
    });
  });

  let picker = null;
  if (myTurn && ui.card) {
    picker = h('div', { class: 'panel stack' },
      h('h3', null, 'Chi l’ha scritta?'),
      h('div', { class: 'suspects' }, suspects.map((id) =>
        h('button', { class: ui.suspect === id ? 'selected' : '', onclick: () => { ui.suspect = id; render(); } }, nameOf(view, id)))),
      h('button', {
        class: 'primary big', disabled: !ui.suspect,
        onclick: () => dispatch({ type: 'guess', cardId: ui.card, suspectId: ui.suspect }),
      }, ui.suspect ? `È di ${nameOf(view, ui.suspect)}!` : 'Scegli un giocatore'),
    );
  }

  return [
    questionCard(view),
    h('div', { class: `turn${myTurn ? ' mine' : ''}` },
      myTurn ? 'Tocca a te! Scegli una risposta' : `Tocca a ${nameOf(view, turn)}`),
    lastEvent(view),
    h('div', { class: 'answers' }, cards),
    picker,
    h('div', { class: 'panel' },
      h('h3', null, 'Ancora in gioco'),
      renderPlayers({ ...view, players: view.players.filter((p) => view.participants.includes(p.id)) }, {
        showScore: true,
        extra: (p) => [
          eliminated.includes(p.id) ? h('span', { class: 'tag' }, 'scoperto') : p.id === turn && h('span', { class: 'tag' }, 'di turno'),
          view.deltas[p.id] ? h('span', { class: 'delta' }, `+${view.deltas[p.id]}`) : null,
        ],
      }),
    ),
    isHost && h('div', { class: 'host-bar row' },
      h('button', { class: 'small', onclick: () => dispatch({ type: 'skipTurn' }) }, `Salta il turno di ${nameOf(view, turn)}`),
    ),
  ];
}

function renderSimultaneous(view, isHost) {
  const inRound = view.participants.includes(view.me);
  const submitted = Boolean(view.simul.myGuesses);
  const editing = inRound && (!submitted || ui.editingGuesses);
  const others = view.participants.filter((id) => id !== view.me);
  const waitingFor = view.participants.filter((id) => !view.simul.submitted.includes(id));

  if (submitted && !ui.editingGuesses && Object.keys(ui.guessDraft).length === 0) {
    ui.guessDraft = JSON.parse(JSON.stringify(view.simul.myGuesses));
  }

  // One name per author, minus yourself if you co-wrote it.
  const needed = (card) => card.count - (card.mine ? 1 : 0);
  const draftOf = (card) => ui.guessDraft[card.id] ?? [];
  const isComplete = (card) => {
    const picks = draftOf(card).filter(Boolean);
    return picks.length === needed(card) && new Set(picks).size === picks.length;
  };
  const toGuess = view.cards.filter((c) => needed(c) > 0);
  const incomplete = toGuess.filter((c) => !isComplete(c)).length;
  const hasRepeats = toGuess.some((c) => {
    const picks = draftOf(c).filter(Boolean);
    return new Set(picks).size !== picks.length;
  });

  const cards = view.cards.map((card) => {
    const mineMeta = card.mine && 'La tua risposta';
    if (!editing || needed(card) === 0) {
      const guess = view.simul.myGuesses?.[card.id];
      return answerCard(view, card, {
        meta: [mineMeta, guess && `Hai detto: ${joinNames(view, guess)}`].filter(Boolean).join(' · '),
      });
    }
    const selects = Array.from({ length: needed(card) }, (_, i) => h('select', {
      key: `guess-${card.id}-${i}`,
      onchange: (e) => {
        const picks = [...draftOf(card)];
        picks[i] = e.target.value;
        ui.guessDraft[card.id] = picks;
        render();
      },
    },
    h('option', { value: '' }, card.mine ? 'Chi altro l’ha scritta?' : needed(card) > 1 ? `Autore ${i + 1}` : 'Chi l’ha scritta?'),
    others.map((id) => {
      const opt = h('option', { value: id }, nameOf(view, id));
      opt.selected = draftOf(card)[i] === id;
      return opt;
    })));
    return answerCard(view, card, { meta: mineMeta, extra: selects });
  });

  return [
    questionCard(view),
    h('p', { class: 'center' }, editing ? 'Abbina ogni risposta al suo autore.' : 'Ecco le risposte!'),
    h('div', { class: 'answers' }, cards),
    editing && h('button', {
      class: 'primary big', disabled: incomplete > 0,
      onclick: () => { ui.editingGuesses = false; dispatch({ type: 'submitGuesses', guesses: ui.guessDraft }); },
    }, hasRepeats ? 'Sulla stessa risposta servono nomi diversi'
      : incomplete > 0 ? `Mancano ${incomplete} rispost${incomplete === 1 ? 'a' : 'e'}`
        : submitted ? 'Aggiorna' : 'Invia le mie risposte'),
    inRound && submitted && !editing && h('div', { class: 'center' },
      h('button', { class: 'small', onclick: () => { ui.editingGuesses = true; render(); } }, 'Cambia le mie scelte')),
    h('div', { class: 'panel' },
      h('h3', null, `Hanno scelto: ${view.simul.submitted.length}/${view.participants.length}`),
      renderPlayers({ ...view, players: view.players.filter((p) => view.participants.includes(p.id)) }, {
        extra: (p) => (view.simul.submitted.includes(p.id)
          ? h('span', { class: 'check' }, 'fatto')
          : h('span', { class: 'waiting-dot' }, 'sta pensando…')),
      }),
    ),
    isHost && waitingFor.length > 0 && view.simul.submitted.length > 0 && h('div', { class: 'host-bar row' },
      h('button', {
        class: 'small',
        onclick: () => confirm('Calcolare i punti senza aspettare chi manca?') && dispatch({ type: 'forceAdvance' }),
      }, 'Vai avanti senza chi manca'),
    ),
  ];
}

function renderResults(view, isHost) {
  const last = view.roundNumber >= view.settings.rounds;
  const cards = view.cards.map((card) => {
    const found = view.simul?.correct[card.id] ?? {};
    let details = [];
    if (view.simul && card.count === 1) {
      const right = found[card.authors[0]] ?? [];
      details = [right.length ? `Indovinata da ${joinNames(view, right)}` : 'Nessuno l’ha indovinata'];
    } else if (view.simul) {
      details = card.authors.map((id) => {
        const right = found[id] ?? [];
        return `Su ${nameOf(view, id)}: ${right.length ? `ci hanno preso ${joinNames(view, right)}` : 'nessuno ci ha preso'}`;
      });
    }
    return answerCard(view, card, {
      meta: [h('strong', null, joinNames(view, card.authors)), details.map((d) => h('span', { class: 'line' }, d))],
    });
  });
  const twins = view.cards.filter((card) => card.count > 1);

  const survivor = view.classic?.survivor;
  return [
    questionCard(view),
    h('h2', { class: 'center' }, 'Ecco chi ha scritto cosa!'),
    survivor && h('div', { class: 'event good' },
      `Nessuno ha scoperto ${nameOf(view, survivor)}: +${SURVIVOR_BONUS} punti bonus!`),
    twins.map((card) => h('div', { class: 'event' },
      `Stessa testa! ${joinNames(view, card.authors)} hanno scritto «${card.text}».`)),
    h('div', { class: 'answers results' }, cards),
    h('div', { class: 'panel' },
      h('h3', null, 'Classifica'),
      renderPlayers(view, {
        showScore: true,
        canKick: isHost,
        extra: (p) => view.deltas[p.id] ? h('span', { class: 'delta' }, `+${view.deltas[p.id]}`) : null,
      }),
    ),
    isHost
      ? h('button', { class: 'primary big', onclick: () => dispatch({ type: 'next' }) },
        last ? 'Classifica finale' : 'Prossimo round →')
      : h('p', { class: 'center muted' }, 'In attesa dell’host…'),
  ];
}

function renderEnd(view, isHost) {
  const top = Math.max(...view.players.map((p) => p.score));
  const winners = view.players.filter((p) => p.score === top);
  return [
    h('div', { class: 'panel podium' },
      h('div', { class: 'trophy' }, 'Vincitore'),
      h('h2', null, winners.length === 1
        ? `Vince ${winners[0].name}!`
        : `Pareggio tra ${winners.map((p) => p.name).join(' e ')}!`),
      h('p', { class: 'muted' }, `con ${top} punt${top === 1 ? 'o' : 'i'}`),
    ),
    h('div', { class: 'panel' },
      h('h3', null, 'Classifica finale'),
      renderPlayers(view, { showScore: true, canKick: isHost }),
    ),
    isHost
      ? h('div', { class: 'stack' },
        h('button', { class: 'primary big', onclick: () => dispatch({ type: 'start' }) }, 'Gioca ancora'),
        h('button', { class: 'big', onclick: () => dispatch({ type: 'backToLobby' }) }, 'Torna alla lobby'))
      : h('p', { class: 'center muted' }, 'In attesa dell’host…'),
  ];
}

// --- Session lifecycle ----------------------------------------------------------------------------

function showView(view) {
  const json = JSON.stringify(view);
  if (json === app.lastViewJson && app.screen === 'game') return;
  app.lastViewJson = json;
  app.view = view;
  if (app.screen !== 'game') {
    app.screen = 'game';
    save(session, KEY_ROLE, { code: app.code, host: app.isHost });
    setHash(app.code);
  }
  render();
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

async function startHost(code, game) {
  app.code = code;
  app.isHost = true;
  const host = new HostSession({
    transport,
    game,
    code,
    save: (state) => save(local, hostKey(code), { state, savedAt: Date.now() }),
    onView: (view) => app.session === host && showView(view),
    onError: toast,
  });
  app.session = host;
  await host.open();
}

async function createRoom(name) {
  app.homeError = '';
  app.screen = 'connecting';
  app.connectingText = 'Creo la stanza…';
  render();
  const pid = myPid();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await startHost(randomCode(), Game.create(pid, name, { questions: QUESTIONS }));
      return;
    } catch (err) {
      if (err.type !== 'taken') return endSession('error', 'Non riesco a creare la stanza. Controlla la connessione e riprova.');
    }
  }
  endSession('error', 'Non riesco a creare la stanza, riprova.');
}

async function resumeHost(code) {
  const state = savedHost(code);
  if (!state) return endSession('error', 'Non ho più i dati di quella partita.');
  for (const p of state.players) p.connected = p.id === state.hostId;
  save(session, KEY_PID, state.hostId);
  app.homeError = '';
  app.resumeOffer = null;
  app.screen = 'connecting';
  app.connectingText = 'Riapro la stanza…';
  render();
  // After a reload the broker may still hold the old peer ID for a few seconds.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (app.screen !== 'connecting') return;
    try {
      await startHost(code, new Game(state, { questions: QUESTIONS }));
      return;
    } catch (err) {
      if (err.type !== 'taken') break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  endSession('error', 'Non riesco a riaprire la stanza, riprova tra poco.');
}

function joinRoom(code, name) {
  app.homeError = '';
  app.resumeOffer = null;
  app.code = code;
  app.isHost = false;
  app.screen = 'connecting';
  app.connectingText = `Entro nella stanza ${code}…`;
  render();
  const client = new ClientSession({
    transport,
    code,
    playerId: myPid(),
    name,
    onView: (view) => {
      if (app.session !== client) return;
      save(session, KEY_PID, view.me);
      showView(view);
    },
    onStatus: (status) => app.session === client && renderStatus(status),
    onError: toast,
    onEnd: (reason, message) => app.session === client && endSession(reason, message),
  });
  app.session = client;
  client.connect();
}

const END_MESSAGES = {
  notfound: (code) => `Non trovo la stanza ${code}. Controlla il codice o chiedi un nuovo link.`,
  kicked: () => 'L’host ti ha rimosso dalla stanza.',
  closed: () => 'L’host ha chiuso la stanza.',
};

function endSession(reason, message) {
  const { code } = app;
  const current = app.session;
  app.session = null;
  current?.close();
  renderStatus('online');
  save(session, KEY_ROLE, null);
  setHash('');
  app.view = null;
  app.lastViewJson = '';
  app.screen = 'home';
  app.homeError = message ?? END_MESSAGES[reason]?.(code) ?? '';
  app.prefillCode = reason === 'notfound' ? code : '';
  app.resumeOffer = reason === 'notfound' && savedHost(code) ? code : null;
  ui = freshUi();
  render();
}

function leave() {
  if (app.isHost) {
    if (!confirm('Se esci la stanza verrà chiusa per tutti. Uscire?')) return;
    save(local, hostKey(app.code), null);
    endSession('left');
  } else if (confirm('Uscire dalla stanza?')) {
    endSession('left');
  }
}

// --- Boot -----------------------------------------------------------------------------------------

function boot() {
  pruneSavedHosts();
  const code = location.hash.slice(1).toUpperCase();
  const role = load(session, KEY_ROLE);
  const name = cleanName(load(local, KEY_NAME));

  if (code.length === CODE_LENGTH) {
    if (role?.host && role.code === code && savedHost(code)) return resumeHost(code);
    // Rejoin straight away after a reload; a fresh invite link asks for the name first.
    if (role?.code === code && name) return joinRoom(code, name);
    app.prefillCode = code;
  }
  render();
}

boot();
