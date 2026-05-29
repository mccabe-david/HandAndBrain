// Worker URL — update after first `wrangler deploy`.
// The deploy will print something like: https://hand-and-brain.<your-subdomain>.workers.dev
export const WORKER_WS_URL = 'wss://hand-and-brain.davidquill.workers.dev'

export const LICHESS_API = 'https://lichess.org'

// Single hardcoded room; only one Hand-Brain pair will ever use this.
export const ROOM_ID = 'manoybrain'

// Open-seek defaults: 3+2 blitz.
export const SEEK_TIME_MINUTES = 3
export const SEEK_INCREMENT_SECONDS = 2

// Brain's revision window after the first legal pick of a turn.
export const REVISION_WINDOW_MS = 4000

// localStorage keys.
export const LS_LICHESS_TOKEN = 'hb.lichessToken'
export const LS_PASSPHRASE = 'hb.passphrase'
