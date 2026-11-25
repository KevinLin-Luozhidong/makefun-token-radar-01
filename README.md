# makefun-token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/KevinLin-Luozhidong/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/KevinLin-Luozhidong/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: every protocol DefiLlama tracks that records no token, ranked by a fitted implied value — with the steps to farm each one. The program reads the sealed DefiLlama snapshot (758 protocols, 2026-11-14), fits a robust log-log valuation on the protocols that already record a token (log10 market cap = 2.9475 + 0.5443 × log10 TVL, n=106, leave-one-out median error 3.08×, walk-forward median error 2.61×, both on the base line before the category, growth and maturity multipliers), and ranks 174 pre-token protocols: all 40 on the house watchlist plus 134 early ones below the $50M floor. Every row carries an 80% uncertainty band, a registry rate — the share of similar protocols that already record a token, never a launch prediction — a naive cross-check, and a six-step farm plan built from the row's own TVL, growth, age, cross-check and band, with costs and times. The dashboard is static HTML/JS with no network, and the program accounts for all 758 protocols — including the 272 that record a token by CoinGecko id or symbol but carry no market cap, and the 20 that pass the visible house rule above the floor but are not on the watchlist and are not ranked: those 20 are listed below the board with their fitted values instead of hidden. An implied value is this entry's estimate from the snapshot's own figures, never a promise that a token will be issued.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22 or later, standard library only. The run writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`, and is deterministic: the same snapshot bytes always write the same output bytes.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
