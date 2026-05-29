# 0001 — Cloudflare Worker as the Brain↔Hand coordination channel

## Status

Accepted, 2026-05-28.

## Context

The Hand and the Brain run on separate devices and must share two things in near-real-time:

- **Brain → Hand:** the current hint (a piece type, plus revision-window metadata).
- **Hand → Brain:** the current confirmed board position (FEN), so the Brain can see what they're hinting about.

Crucially, neither the hint nor the position may be visible to the Lichess opponent, because revealing the Brain's nomination defeats the variant. The site is deployed as a static bundle on GitHub Pages, which rules out any solution that requires a private server-side secret.

## Decision

Use a Cloudflare Worker backed by a single Durable Object as a websocket relay between the two devices. The Worker holds the latest FEN and latest hint and re-pushes them to any reconnecting socket. Access is gated by a shared passphrase pasted into each device once and held in `localStorage`. There is one hardcoded room, since only one Hand-Brain pair will ever use it.

## Consequences

- The Brain never touches the Lichess API. The token is confined to the Hand device.
- The protocol can assume connected, server-mediated state (room memory, last-writer-wins on duplicate sockets, 5-minute reconnect window). That assumption is woven into the design — replacing the transport later would mean redesigning these mechanics, not just swapping a client.
- One additional deployment artefact lives outside GitHub Pages (the Worker on `*.workers.dev`). Its URL is hardcoded in `src/config.ts`.
- The Worker is a single point of failure for coordination. If Cloudflare is down, the variant cannot be played, even if Lichess is up.

## Alternatives considered

- **In-game Lichess chat over the Board API event stream.** Genuinely zero-infrastructure: the Board stream already delivers `chatLine` events in realtime, and posting chat is one API call. Rejected because the opponent can read in-game chat. Every hint would be visible to them, which defeats the variant.
- **Lichess Studies API as a message channel.** Considered encoding hints into study titles. Rejected because (a) studies have no realtime push (only HTTP polling, against a shared rate limit), (b) there is no public "rename study" endpoint — each new hint would require creating a new study, and (c) studies are public by URL.
- **A second Lichess account as a backchannel** (e.g. private messages or spectator chat). Rejected because Lichess Terms of Service forbid multi-accounting without prior permission; the risk of the primary account being flagged is real even though the intent is not cheating.
- **WebRTC peer-to-peer with manual signaling** (paste an offer SDP from Brain into Hand, paste an answer back). Rejected because every game requires the paste-dance, and NAT traversal still typically depends on a STUN/TURN server, so "no infrastructure" turns out to be untrue in practice.
- **A managed realtime backend (Firebase Realtime DB, Supabase, Ably, PartyKit).** Each of these would have worked. The Worker was preferred for the lightest setup at this scale (~40 lines of code, no separate account, free, deployed via `wrangler`). If usage ever grows beyond one Hand-Brain pair, one of these would be a stronger fit.
