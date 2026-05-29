# Context

Glossary of the domain language used in this project. Implementation details belong in code or ADRs, not here.

## Hand and Brain

A 2v2 chess team variant. Each side has two roles:

- **Brain** — names a piece *type* (pawn, knight, bishop, rook, queen, king) at the start of the team's turn. Sees the board, but never makes a move.
- **Hand** — must move *some* piece of the type the Brain named. Chooses which specific piece and where it goes. Sees the board and the Brain's nominated type, nothing else from the Brain.

In this app, the two roles run on **separate devices**. The Hand page hosts the actual Lichess game; the Brain page is a remote control that broadcasts the nominated piece type.

## Lichess account

The Hand connects to Lichess as account `manoybrain` using a personal access token with `board:play` scope. The token is pasted at runtime and stored in browser `localStorage` — never bundled into the deployed site.

## Coordination channel

The private channel between Hand and Brain is a Cloudflare Worker (websocket relay, backed by a Durable Object). Hint messages from Brain are invisible to the Lichess opponent because they never touch Lichess. The static site is hosted on GitHub Pages; the worker runs on a separate `*.workers.dev` URL.

Only the Hand device holds the Lichess token. Hand streams game events from Lichess and relays the current position (FEN) to Brain through the worker. Brain never talks to Lichess directly — its only network connection is the worker.

There is only ever one Hand-Brain pair, so the worker uses a single hardcoded room. No pairing UI; the two pages just connect. If a stale tab reconnects in either role, the newest socket replaces the older one (last writer wins).

The worker's Durable Object holds the latest FEN and the latest hint (with metadata: turn, locked-in flag, time-of-first-legal-pick). On any reconnect in either role, the worker re-pushes this state to the reconnecting socket. State is cleared five minutes after both sockets have disconnected.

## Room passphrase

A short shared secret that both the Hand and Brain pages must include on their websocket connection to the worker. The worker rejects connections without it. The passphrase is pasted into each device once on first use and stored in `localStorage`; it never appears in the deployed bundle.

## Turn vocabulary

- **Hint** — the piece type the Brain nominates for the current turn. The Hand is constrained to move some piece of this type.
- **Pre-commit** — a hint chosen by the Brain during the opponent's turn, before our turn has started. The Brain sees only confirmed positions, so a pre-commit may turn out to be impossible once the opponent moves.
- **Revision window** — a short period during which the Brain may still revise their hint for the current turn. The Hand sees every revision immediately (no delay), so Hand can act on the latest hint at any moment. Once the window closes, the Brain's pick is final for the rest of the turn — the Hand may continue to deliberate, but the hint will not change. The window cannot be extended.
- **Impossible hint** — a hint for a piece type with zero legal moves in the current position. The Hand rejects it; the Brain must pick again.
