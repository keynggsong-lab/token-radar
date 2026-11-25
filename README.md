# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/keynggsong-lab/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/keynggsong-lab/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's "Build the best token launch radar" bounty. It takes a sealed
snapshot of 758 protocols, puts aside the ones whose token already trades, ranks the 198 that
record no token by what a launch would be worth, and writes a farm plan for each of them.

## The model

```
implied_value = TVL × peer_multiple × momentum × tenure
```

- `peer_multiple` — the median market cap ÷ TVL of the live tokens in the protocol's own
  category, worked out from the same snapshot. A category needs four live peers to speak for
  itself; otherwise the market-wide median stands in.
- `momentum` — `1 + 7-day TVL change × 0.30`, held between 0.85× and 1.45×.
- `tenure` — `0.72 + min(years without a token, 3) ÷ 3 × 0.28`: TVL that has survived longer
  counts for more than TVL that arrived last month.

No protocol is named anywhere in the code; every row is scored on the same four fields. A second
score, launch pressure (0–100), says how likely a launch looks from the protocol's size, its
category's tokenisation rate, its tenure and its growth. It drives the "hot" filter and never
touches the value.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
node main.ts --input /input/snapshot.json --shots   # re-render the three screenshots (needs a browser)
node main.ts --input /input/snapshot.json --serve 8080
```

`main.ts` writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and
`out/dossier.json` (the last built with `buildDossier` from `vendor/makefun-board.ts`). Node 22.18
or later; no dependencies, no build step, standard library only.

## The page

`dashboard/` is a static page — `index.html`, `app.css`, `app.js` — that renders with no network.
It carries the ranked board, a detail view for every protocol (the formula, its four factors, and
the farm plan with a cost and a time per step), and filters by tab, category, chain and free text,
with a sort on every numeric column. The three screenshots show the board, one protocol's detail
view, and a filtered view. The board is validated before it is written: at least 100 rows, every
watchlist slug covered, ranks 1 to N with implied value never rising as rank ascends.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
