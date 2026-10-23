# Dopa's Discord Purifier ✨

Wipe every message *you* sent in a DM, group or server — gently, in a few clicks.
Nothing else is touched.

<p align="center"><img src="docs/img/purging.webp" alt="The purifier panel mid-purge next to its log window, inside Discord" width="720"></p>

## Get it

**→ [codemaker66.github.io/discord-stuff](https://codemaker66.github.io/discord-stuff/)**

That page works out which browser you're on, walks you through the two-minute setup,
and ticks itself off once the purifier is installed. It's also the link to send a friend.

Already have Tampermonkey or Violentmonkey?
[Install the script directly](https://raw.githubusercontent.com/codemaker66/discord-stuff/main/dist/dopas-discord-purifier.user.js) —
it updates itself from the same link.

On the Discord desktop app with BetterDiscord? Drop
[`DopasPurifier.plugin.js`](https://codemaker66.github.io/discord-stuff/downloads/DopasPurifier.plugin.js)
into your plugins folder and switch it on.

## What it does

- **Scan** any chat to see how many of your messages are in it and how long a purge takes.
- **Hold to purify** — no accidental clicks.
- **Batch**: tick DMs, groups and server channels (threads and forum posts included), then purge them in one go.
- **Shield** anyone and their chat is immune. Bardo is shielded from the start ♡
- Paces itself to Discord's rate limits, pauses and resumes, and tells you honestly what was skipped.

It runs inside Discord in your own browser, with the session you're already logged in with,
and talks to Discord and nothing else.

## Working on it

```sh
npm install
npm run build   # src/ → dist/ (userscript + BetterDiscord plugin) and docs/
npm run check   # fails if dist/ or docs/ are out of date with src/
npm test        # end-to-end tests against a mock Discord (Playwright + Chromium)
node test/site.mjs                                   # install-page tests
node test/shots.mjs dist/dopas-discord-purifier.user.js test/out/shots 2 --showcase
```

Edit `src/`, never `dist/` — the build rewrites it. Bump `version` in `package.json` to ship an
update: installed copies pick it up from `dist/` on `main`, and the install page shows the new version.

Made with ♡ by Bardo & Dopa · not affiliated with Discord
