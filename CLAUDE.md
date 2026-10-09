# Brashaus

A "Game of Things"-style browser party game: players answer a question anonymously, then guess who wrote what.
UI language: Italian.

## Requirements

- Static site, hostable on GitHub Pages. No backend, no servers we run.
- Real time, peer-to-peer (WebRTC via PeerJS). Public signaling broker and STUN are only for the handshake.
- No build step: plain HTML/CSS/JS.
- Mobile-friendly.
- Look: green palette (tokens on `:root` in `css/style.css`, light + dark), Google Sans everywhere.
- No emoji anywhere in the UI (favicon included).

## Architecture

- Star topology: the host is the only "server"; every other player connects to the host only.
- Host owns all game state. Clients send actions, the host sends back a per-player filtered view
  (never reveal what a player shouldn't see yet).
- Room code = host peer ID. Players keep a persistent ID so they can rejoin after a reload.
- Keep transport separate from game logic so it can be swapped later.

## Game

- Minimum 3 players.
- Everyone answers a question; nothing is shown until all players have answered.
- Answers are then revealed and players guess the authors. The host picks the mode in the lobby:
  - **Classica**: turn-based. The current player picks an answer and a suspect. Right: +1 and they guess again,
    the author is out (their answer is revealed). Wrong: turn passes. Last one standing gets +2.
  - **Simultanea**: everyone matches every answer to an author at once. +1 per right match,
    and the author gets +1 for every player who matched their answer wrong.
- Identical answers (case-insensitive only; punctuation, accents and wording still count) become one card
  with several authors. Everyone sees "Scritta da N", not by whom. Naming any hidden author counts as right.
  - Classica: each right guess reveals one author; the card stays in play until all are found.
    A co-author may guess on their own shared card.
  - Simultanea: one name per author (co-authors name the others); scoring is per author as above.
- Host picks the number of rounds (3/5/8/10). Questions come from `js/questions.js`, no repeats until the deck runs out.
- Name: Brashaus, an in-joke of ours, don't change it (`APP_NAME` in `js/app.js`, PeerJS id prefix in `js/transport.js`, storage keys `bh.*`).

## Code map

- `js/game.js`: pure game logic + per-player filtered views. No DOM, no network.
- `js/session.js`: `HostSession` / `ClientSession`, wire protocol, heartbeat, rejoin.
- `js/transport.js`: PeerJS transport, plus a BroadcastChannel one for same-browser tabs (`?local` in the URL).
- `js/app.js`: UI (plain DOM), storage, boot/resume. Player ID lives in sessionStorage (per tab).

## Testing

- `./tests/run.sh`: logic and protocol tests on macOS JavaScriptCore (no Node in this environment).
- Manual: `python3 -m http.server 8000`, then 3+ tabs on `http://localhost:8000/?local` (offline) or without `?local` (real PeerJS).

## Working agreements

- Test with at least 3 browser tabs after each change.
- Let's have fun!