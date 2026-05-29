# Hand and Brain

A two-device companion app for the Hand-and-Brain chess variant on Lichess. One device plays the Hand (interactive board, plays moves on Lichess). The other plays the Brain (read-only board, nominates a piece type each turn). A Cloudflare Worker carries hints and positions between the two so the opponent never sees them.

Background and design rationale: [CONTEXT.md](CONTEXT.md), [docs/adr/0001-cloudflare-worker-as-coordination-channel.md](docs/adr/0001-cloudflare-worker-as-coordination-channel.md).

## One-time setup

### 1. Create a Lichess token

1. Sign in to `manoybrain` on lichess.org.
2. Visit https://lichess.org/account/oauth/token/create and create a token with the **board:play** scope.
3. Copy it somewhere safe — you'll paste it into the Hand device on first load.

### 2. Deploy the Cloudflare Worker

```sh
cd worker
npm install
npx wrangler login          # opens a browser tab
npx wrangler secret put ROOM_PASSPHRASE
# When prompted, type your chosen passphrase (e.g. HARIKA) and press enter.
npx wrangler deploy
```

The deploy prints a URL like `https://hand-and-brain.<your-subdomain>.workers.dev`. Copy it.

### 3. Point the frontend at the Worker

Edit [src/config.ts](src/config.ts) and set `WORKER_WS_URL` to the deploy URL with `wss://` instead of `https://`. Commit and push.

### 4. Enable GitHub Pages

In the repo's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**. The workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) deploys on every push to `main`.

The site goes live at `https://mccabe-david.github.io/HandAndBrain/`.

## First load

- Open `https://mccabe-david.github.io/HandAndBrain/#/hand` on the device that will be the Hand. Paste the Lichess token and the passphrase.
- Open `https://mccabe-david.github.io/HandAndBrain/#/brain` on the Brain device. Paste only the passphrase.

Both devices remember their inputs in `localStorage` after that.

## Local development

```sh
npm install
npm run dev          # frontend on http://localhost:5173/HandAndBrain/

# In another terminal:
cd worker
npx wrangler dev     # local worker; pair with a wss://… or http://localhost overlay
```

For local dev, temporarily edit `WORKER_WS_URL` to point at the local wrangler endpoint.

## Layout

- `src/pages/Hand.tsx`, `src/pages/Brain.tsx` — the two roles.
- `src/components/` — shared UI (board, setup screen, result banner, piece icon).
- `src/lib/` — Lichess client, Worker websocket client, protocol types.
- `src/config.ts` — constants you may need to edit (Worker URL, time control, revision window).
- `worker/` — Cloudflare Worker source + wrangler config.
