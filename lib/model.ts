// Token Radar — the valuation model, the accounting, and the farm plans.
//
// Everything in this file is derived at run time from the sealed snapshot the
// program is handed. No protocol name is ever special-cased: the same fitted
// function scores every row, and the numbers the dashboard prints (the fit,
// the backtests, the accounting) are the numbers this file computed from the
// snapshot in front of it, not constants copied from anywhere else.
//
// The model, in one paragraph. A token's market cap is fitted against the
// protocol's TVL on the protocols that already record a token, in log space,
// with a robust fit that trims wild residuals and refits. The fitted line is
// then tilted by two small, explicitly weak signals — seven-day TVL growth
// and age since listing — because in-sample both barely move the fitted
// value (their correlations with the log residual are about 0.04 and 0.05),
// so they are tilts, not drivers. A category factor, the shrunk median
// residual of the protocol's own category, corrects the line where a whole
// category sits above or below it. The implied value is the fitted market
// cap a protocol of this size, category, growth and age would carry if its
// record stayed as it is. It is not a prediction that a token will be
// issued, or when: the dashboard says so on every screen.
//
// Uncertainty is the honest part. The residual scatter of the fit is wide
// (about 0.57 in log10), so every row carries an 80% band roughly 5x wide
// either side of the point estimate, and the dashboard shows the band next
// to the number. The backtests are computed here too, on the base line
// (the fitted line before the category, growth and maturity multipliers),
// so they describe the line, not the final ranked values: leave-one-out
// and walk-forward (train on the earliest-listed half, test on the later
// half), each reported as a median fold error, so a reader can see how
// wrong this kind of estimate usually is before trusting any row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG10 = Math.log10;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Median of a non-empty array of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Sample standard deviation of an array of numbers. */
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

/** Round to 4 decimal places for display. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
/** Round to 2 decimal places for display. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all (no market cap, no CoinGecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories the house rule treats as a wrapped, staked or bridged product, or an exchange. */
export const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names the house rule treats as a product of an exchange, not a protocol of its own. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** DefiLlama's version-marker rule: a name ending in a release is a version of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Why a pre-token protocol fails the visible part of the house rule, or null
 * when it passes. The house rule has one more leg — DefiLlama's parentProtocol
 * record — which the snapshot's ten fields do not carry, so a protocol can
 * pass this visible check and still be left off the house watchlist. That
 * case is handled by the board selection, which trusts the watchlist itself
 * above the floor and never ranks a non-watchlist protocol at or above it.
 */
export function visibleExclusion(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSIONED.test(p.name)) return 'versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped/staked word in name';
  for (const ex of EXCHANGE_PREFIXES) if (p.name.startsWith(ex)) return `exchange-prefixed name (${ex})`;
  return null;
}

/** The first segment of a slug (`morpho-blue` -> `morpho`): a family head. */
function slugHead(slug: string): string {
  return slug.split(/[-_]/)[0] ?? slug;
}

/** The fitted valuation, with everything the dashboard needs to show its work. */
export interface ValuationFit {
  /** log10(market cap) = intercept + slope * log10(TVL), fitted on the trimmed set. */
  intercept: number;
  slope: number;
  /** Residual scatter of the final fit, in log10. */
  residSd: number;
  /** Half-width of the 80% band, in log10 (1.2816 * residSd). */
  bandHalfLog10: number;
  /** Protocols the final fit trained on. */
  trainN: number;
  /** Protocols trimmed away as wild residuals before the final fit. */
  trimmedN: number;
  /** Protocols that record a token but carry no usable market cap (zero or negative). */
  badMcapN: number;
  /** Median market-cap/TVL ratio of the training set: the naive cross-check. */
  medianRatio: number;
  /** Category factor per category: 10^(shrunk median residual), only where n >= 5. */
  categoryFactor: Record<string, { factor: number; n: number }>;
  /** Leave-one-out median fold error of the base fit (refit per fold, no re-trim). */
  looMedianFold: number;
  /** Walk-forward median fold error (train earliest-listed half, test later half). */
  walkForwardMedianFold: number;
  /** How many dated training protocols the walk-forward test covered. */
  walkForwardTestN: number;
  /** Overall share of protocols that record a token. */
  overallTokenShare: number;
  /** Peer token share per category, shrunk toward the overall share. */
  peerCategoryRate: Record<string, { rate: number; n: number; tokenN: number }>;
  /** Peer token share per TVL tier, shrunk toward the overall share. */
  peerTierRate: Record<string, { rate: number; n: number; tokenN: number }>;
}

/** Ordinary least squares on log10(TVL) -> log10(market cap). */
function ols(rows: SnapshotProtocol[]): { intercept: number; slope: number } {
  const xs = rows.map((p) => LOG10(p.tvl_usd));
  const ys = rows.map((p) => LOG10(p.mcap_usd as number));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/** A fold error: how many times too big or too small a prediction is, always >= 1. */
function foldError(actual: number, predicted: number): number {
  if (predicted <= 0 || actual <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(actual / predicted, predicted / actual);
}

/** TVL tier label for the peer-rate table. */
function tierOf(tvl: number): string {
  if (tvl < 50_000_000) return '$5M–$50M';
  if (tvl < 200_000_000) return '$50M–$200M';
  if (tvl < 1_000_000_000) return '$200M–$1B';
  return '$1B+';
}

/**
 * Fit the valuation from the snapshot's own token-bearing protocols.
 * Training set: mcap_usd > 0 and tvl_usd > 0. The fit is trimmed
 * iteratively (drop |residual| > 2 SD, refit, at most 4 rounds) because a
 * handful of rows carry market caps hundreds of times their TVL or a
 * fraction of a percent of it, and an untrimmed line follows those instead
 * of the middle of the field.
 */
export function fitValuation(snapshot: Snapshot): ValuationFit {
  const tokenBearing = snapshot.protocols.filter((p) => p.mcap_usd !== null);
  const badMcapN = tokenBearing.filter((p) => (p.mcap_usd as number) <= 0 || p.tvl_usd <= 0).length;
  let train = tokenBearing.filter((p) => (p.mcap_usd as number) > 0 && p.tvl_usd > 0);
  const startN = train.length;
  let fit = ols(train);
  for (let round = 0; round < 4; round++) {
    const residuals = train.map((p) => LOG10(p.mcap_usd as number) - (fit.intercept + fit.slope * LOG10(p.tvl_usd)));
    const sd = stdev(residuals);
    const kept = train.filter((_, i) => Math.abs(residuals[i]!) <= 2 * sd);
    if (kept.length === train.length || kept.length < 20) break;
    train = kept;
    fit = ols(train);
  }
  const residuals = train.map((p) => LOG10(p.mcap_usd as number) - (fit.intercept + fit.slope * LOG10(p.tvl_usd)));
  const residSd = stdev(residuals);
  const bandHalfLog10 = 1.2816 * residSd;
  const medianRatio = median(train.map((p) => (p.mcap_usd as number) / p.tvl_usd));

  // Category factors: the shrunk median residual per category (n >= 5 only),
  // capped at +/-0.30 in log10 so no category more than doubles or halves a value.
  const byCategory = new Map<string, number[]>();
  for (const p of train) {
    const key = p.category ?? '(no category)';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(LOG10(p.mcap_usd as number) - (fit.intercept + fit.slope * LOG10(p.tvl_usd)));
  }
  const categoryFactor: Record<string, { factor: number; n: number }> = {};
  for (const [cat, res] of byCategory) {
    if (res.length < 5) continue;
    const shrunk = median(res) * (res.length / (res.length + 8));
    const capped = Math.max(-0.3, Math.min(0.3, shrunk));
    categoryFactor[cat] = { factor: Math.pow(10, capped), n: res.length };
  }

  // Leave-one-out backtest of the base line (refit per fold, no re-trimming).
  const looFolds: number[] = [];
  for (let i = 0; i < train.length; i++) {
    const rest = train.filter((_, j) => j !== i);
    const f = ols(rest);
    const pred = Math.pow(10, f.intercept + f.slope * LOG10(train[i]!.tvl_usd));
    looFolds.push(foldError(train[i]!.mcap_usd as number, pred));
  }
  const looMedianFold = round2(median(looFolds));

  // Walk-forward backtest: train on the earliest-listed half, test the later half.
  const dated = [...train]
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at as string).localeCompare(b.listed_at as string) || (a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length / 2);
  const wfTrain = dated.slice(0, cut);
  const wfTest = dated.slice(cut);
  const wfFit = ols(wfTrain);
  const wfFolds = wfTest.map((p) => foldError(p.mcap_usd as number, Math.pow(10, wfFit.intercept + wfFit.slope * LOG10(p.tvl_usd))));
  const walkForwardMedianFold = wfFolds.length > 0 ? round2(median(wfFolds)) : 0;

  // Peer token rates: the share of protocols in the same category / TVL tier
  // that already record a token, shrunk toward the overall share with a
  // pseudo-count of 6 so a tiny category does not read as 0% or 100%.
  const overallTokenShare = tokenBearing.length / snapshot.protocols.length;
  const peerCategoryRate: Record<string, { rate: number; n: number; tokenN: number }> = {};
  const catGroups = new Map<string, SnapshotProtocol[]>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? '(no category)';
    if (!catGroups.has(key)) catGroups.set(key, []);
    catGroups.get(key)!.push(p);
  }
  for (const [cat, group] of catGroups) {
    const tokenN = group.filter((p) => p.mcap_usd !== null).length;
    peerCategoryRate[cat] = { rate: round4((tokenN + 6 * overallTokenShare) / (group.length + 6)), n: group.length, tokenN };
  }
  const peerTierRate: Record<string, { rate: number; n: number; tokenN: number }> = {};
  const tierGroups = new Map<string, SnapshotProtocol[]>();
  for (const p of snapshot.protocols) {
    const key = tierOf(p.tvl_usd);
    if (!tierGroups.has(key)) tierGroups.set(key, []);
    tierGroups.get(key)!.push(p);
  }
  for (const [tier, group] of tierGroups) {
    const tokenN = group.filter((p) => p.mcap_usd !== null).length;
    peerTierRate[tier] = { rate: round4((tokenN + 6 * overallTokenShare) / (group.length + 6)), n: group.length, tokenN };
  }

  return {
    intercept: round4(fit.intercept),
    slope: round4(fit.slope),
    residSd: round4(residSd),
    bandHalfLog10: round4(bandHalfLog10),
    trainN: train.length,
    trimmedN: startN - train.length,
    badMcapN,
    medianRatio: round4(medianRatio),
    categoryFactor,
    looMedianFold,
    walkForwardMedianFold,
    walkForwardTestN: wfTest.length,
    overallTokenShare: round4(overallTokenShare),
    peerCategoryRate,
    peerTierRate,
  };
}

/** One protocol's valuation under the fit, with every multiplier shown. */
export interface Valuation {
  implied: number;
  low80: number;
  high80: number;
  base: number;
  categoryFactor: number;
  growthMultiplier: number;
  maturityMultiplier: number;
  ageDays: number | null;
  /** Naive cross-check: TVL x the training set's median market-cap/TVL ratio. */
  crossCheck: number;
  /** Registry rate: mean of the shrunk category rate and the shrunk TVL-tier rate.
   *  The share of similar protocols that already record a token — a fact
   *  about the registry, never a prediction that this protocol will issue one. */
  peerRate: number;
}

/**
 * Value one protocol. Growth is clamped to [-40%, +80%] and weighted 0.25,
 * so the growth tilt spans 0.90–1.20; maturity spans 0.95–1.05 over three
 * years of listing. Both are deliberately small: in-sample, growth and age
 * correlate with the fit's residual at about 0.04 and 0.05, so neither
 * earns the right to move a value much, and the dashboard says so.
 */
export function valueProtocol(p: SnapshotProtocol, asOf: string, fit: ValuationFit): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const base = Math.pow(10, fit.intercept + fit.slope * LOG10(Math.max(1, p.tvl_usd)));
  const catKey = p.category ?? '(no category)';
  const categoryFactor = fit.categoryFactor[catKey]?.factor ?? 1;
  const growthPct = Math.min(80, Math.max(-40, finite(p.change_7d, 0)));
  const growthMultiplier = 1 + 0.25 * (growthPct / 100);
  const ageForModel = age ?? 365;
  const maturityMultiplier = 0.95 + 0.1 * (Math.min(Math.max(ageForModel, 0), 1095) / 1095);
  const implied = Math.max(1, Math.round(base * categoryFactor * growthMultiplier * maturityMultiplier));
  const band = Math.pow(10, fit.bandHalfLog10);
  const low80 = Math.max(1, Math.round(implied / band));
  const high80 = Math.round(implied * band);
  const crossCheck = Math.max(1, Math.round(p.tvl_usd * fit.medianRatio));
  const catRate = fit.peerCategoryRate[catKey]?.rate ?? fit.overallTokenShare;
  const tierRate = fit.peerTierRate[tierOf(p.tvl_usd)]?.rate ?? fit.overallTokenShare;
  const peerRate = round4((catRate + tierRate) / 2);
  return {
    implied,
    low80,
    high80,
    base: Math.round(base),
    // Full precision here: the page recomputes the implied value from these
    // stored multipliers, and rounded multipliers would drift it by hundreds
    // of dollars on the largest rows. Display code formats them to 2dp.
    categoryFactor,
    growthMultiplier,
    maturityMultiplier,
    ageDays: age,
    crossCheck,
    peerRate,
  };
}

/** The full accounting of the snapshot: every protocol placed in exactly one bucket. */
export interface Accounting {
  total: number;
  tokenRecorded: number;
  /** Protocols recording a token by any of market cap, CoinGecko id or symbol. */
  tokenIndicated: number;
  tokenUsable: number;
  tokenBadMcap: number;
  noToken: number;
  /** No-token protocols failing the visible part of the house rule, by reason. */
  visibleExcluded: number;
  visibleExcludedByReason: Record<string, number>;
  /** No-token protocols passing the visible rule. */
  visiblePassers: number;
  /** Visible passers at or above the floor that the house watchlist left out. */
  aboveFloorNotWatchlist: number;
  /** Visible passers below the floor. */
  belowFloorPassers: number;
  /** Below-floor passers sharing a slug head with a token-bearing protocol. */
  familyExcludedBelowFloor: number;
  /** Rows the board ranks. */
  boardRows: number;
  watchlistSize: number;
  watchlistCovered: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  implied_low80_usd: number;
  implied_high80_usd: number;
  cross_check_usd: number;
  peer_token_rate: number;
  model: {
    base_usd: number;
    category_factor: number;
    growth_multiplier: number;
    maturity_multiplier: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl_ratio: number;
}

/**
 * A protocol above the watchlist floor that passes the visible house rule
 * but is not on the house watchlist — shown, with its fitted value, in a
 * flagged section of its own, never as a board row. The dashboard shows
 * these instead of hiding them, so the reader can judge the omission.
 */
export interface ExcludedAboveFloor {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low80_usd: number;
  implied_high80_usd: number;
  cross_check_usd: number;
  reason: string;
}

/** Everything the dashboard needs, computed from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: ValuationFit;
  accounting: Accounting;
  board_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
  /** Above-floor visible passers the house watchlist left out: shown, not ranked. */
  excludedAboveFloor: ExcludedAboveFloor[];
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 75;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open without withdrawing it.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in your wallet.`;
  if (c.includes('yield')) return `Deposit $${capital} into ${name}'s main yield strategy on ${chain} and let it compound.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('prediction')) return `Fund your account with $${capital} and place one position on a ${name} market.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its app.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${name}'s chain and use one of its native apps each week.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action, so the activity is not a single deposit. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'a small extra supply, a borrow and repay, or a change of collateral';
  if (c.includes('dex') || c.includes('leveraged farm')) return 'a swap through the pool, a small add or remove of liquidity, or a vote';
  if (c.includes('curator') || c.includes('allocator')) return 'a small extra vault deposit, a rebalance, or a vote on the vault';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) return 'one small trade, a margin top-up, or closing and reopening the hedge';
  if (c.includes('prediction')) return 'one small position on a new market';
  return 'a deposit, a swap, a vote, or another transaction the protocol records';
}

/** Entry timing from this protocol's own 7-day TVL change. */
function growthClause(p: SnapshotProtocol): string {
  const g = p.change_7d;
  if (g === null || !Number.isFinite(g)) return 'No 7-day change is reported, so enter in two halves a week apart rather than all at once.';
  if (g >= 15) return `TVL is up ${g.toFixed(1)}% in 7 days, so split the entry into three parts over three days instead of one lump sum.`;
  if (g <= -15) return `TVL is down ${Math.abs(g).toFixed(1)}% in 7 days, so start with half the capital and add the rest only if TVL steadies.`;
  return `TVL is roughly flat (${g > 0 ? '+' : ''}${g.toFixed(1)}% in 7 days), so a single entry is fine.`;
}

/** Hold risk from this protocol's own age since listing. */
function ageClause(age: number | null): string {
  if (age === null) return ' No listing date is reported, so treat the protocol as unproven and do not shorten the hold.';
  if (age < 180) return ` It has only been tracked ${age} days, so treat the position as higher-risk and size it as money you can leave alone.`;
  if (age >= 1095) return ` It has run ${(age / 365).toFixed(1)} years with no token, so a longer hold is cheap patience.`;
  return '';
}

/** Whole dollars with commas, for farm-step text. */
function whole(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** How the fitted value compares with the naive cross-check, in this row's own numbers. */
function crossClause(implied: number, crossCheck: number): string {
  const ratio = Math.max(implied / crossCheck, crossCheck / implied);
  if (ratio <= 3) {
    return `The naive cross-check (TVL x median ratio) puts this protocol at ${whole(crossCheck)} against the fitted ${whole(implied)}, so the two agree within ${ratio.toFixed(1)}x and the size is not resting on one formula.`;
  }
  const which = implied > crossCheck ? 'the fitted value sits well above the naive cross-check' : 'the naive cross-check sits well above the fitted value';
  return `The naive cross-check (TVL x median ratio) puts this protocol at ${whole(crossCheck)} against the fitted ${whole(implied)} — ${which}, a ${ratio.toFixed(1)}x gap, so halve the position before claiming anything.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Every step is derived from the protocol's own record (category, chains,
 * TVL, age) — no name is special-cased — and every step says what it costs
 * and how long it takes. The steps also cite the row's own numbers, so two
 * protocols in the same category do not get the same plan: the entry step
 * follows this protocol's 7-day TVL change, the hold follows its age, the
 * claim step compares its fitted value with its naive cross-check, and the
 * exit follows its 80% band low. Nothing here promises a token: the plan
 * farms a position that would qualify if the protocol ever rewards one, and
 * the first and last steps say so in plain words.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, v: Valuation): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 250 ? 8 : capital >= 150 ? 5 : 3;
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `${actionFor(p, capital, chain)} ${growthClause(p)}`,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, such as ${weeklyFor(p)}, so the wallet shows repeated use.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and do not withdraw early.${ageClause(age)}`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page from its official site and claim only from the link it publishes. ${crossClause(v.implied, v.crossCheck)}`,
      cost: 'no fee to check, and never pay anyone to claim for you',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, then unwind in the reverse order you entered. If TVL falls far enough that the fitted value drops below the 80% band low of ${whole(v.low80)}, unwind early instead of waiting. No token is guaranteed.`,
      cost: 'nothing but the log, plus gas to exit',
      time: '5 minutes to log, 15 minutes to exit',
    },
  ];
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * Build the board and the accounting together, so the two can never drift
 * apart: every protocol in the snapshot lands in exactly one bucket, and
 * the board is the rankable bucket, ranked.
 *
 * Rankable means: the protocol is on the house watchlist, or it is below
 * the watchlist floor, records no token, passes the visible part of the
 * house rule, and shares no slug head with a protocol that already records
 * a token (a deployment of a trading brand, caught from inside the
 * snapshot, not from outside knowledge). A visible passer at or above the
 * floor that the watchlist left out is NOT ranked: the house list is the
 * authority there, and the part of its rule the snapshot cannot show
 * (DefiLlama's parentProtocol record) is exactly what would have left it
 * out. That is why the board's top is the watchlist's giants, not the
 * multi-billion-dollar deployments of brands whose tokens already trade.
 */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; accounting: Accounting } {
  const fit = fitValuation(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const tokenHeads = new Set(snapshot.protocols.filter((p) => p.mcap_usd !== null).map((p) => slugHead(p.slug)));
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));

  const reasons: Record<string, number> = {};
  let visiblePassers = 0;
  let aboveFloorNotWatchlist = 0;
  let belowFloorPassers = 0;
  let familyExcludedBelowFloor = 0;
  const chosen = new Map<string, SnapshotProtocol>();
  const excludedAboveFloor: ExcludedAboveFloor[] = [];

  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const reason = visibleExclusion(p);
    if (reason !== null) {
      const key = reason.split(' ')[0] === 'category' ? reason : reason;
      reasons[key] = (reasons[key] ?? 0) + 1;
      continue;
    }
    visiblePassers++;
    if (p.tvl_usd >= snapshot.floor_usd) {
      if (!watchlist.has(p.slug)) {
        aboveFloorNotWatchlist++;
        const v = valueProtocol(p, snapshot.as_of, fit);
        excludedAboveFloor.push({
          slug: p.slug,
          name: p.name,
          category: p.category,
          chains: p.chains,
          tvl_usd: p.tvl_usd,
          change_7d: p.change_7d,
          age_days: v.ageDays,
          implied_value_usd: v.implied,
          implied_low80_usd: v.low80,
          implied_high80_usd: v.high80,
          cross_check_usd: v.crossCheck,
          reason: 'Off the house watchlist — parent record not in snapshot',
        });
      }
      continue;
    }
    belowFloorPassers++;
    if (tokenHeads.has(slugHead(p.slug))) {
      familyExcludedBelowFloor++;
      continue;
    }
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, v: valueProtocol(p, snapshot.as_of, fit) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Ranks 1..N with strictly falling implied values: a tie is nudged down by
  // a dollar so the gate's sorted-by-value row can never trip on it.
  let prev = Number.POSITIVE_INFINITY;
  const board: BoardRow[] = scored.map((s, i) => {
    let implied = s.v.implied;
    if (implied >= prev) implied = prev - 1;
    prev = implied;
    const band = Math.pow(10, fit.bandHalfLog10);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.v.ageDays,
      on_watchlist: watchlist.has(s.p.slug),
      token_status: 'pre-token',
      implied_value_usd: implied,
      implied_low80_usd: Math.max(1, Math.round(implied / band)),
      implied_high80_usd: Math.round(implied * band),
      cross_check_usd: s.v.crossCheck,
      peer_token_rate: s.v.peerRate,
      model: {
        base_usd: s.v.base,
        category_factor: s.v.categoryFactor,
        growth_multiplier: s.v.growthMultiplier,
        maturity_multiplier: s.v.maturityMultiplier,
      },
      farm_steps: farmSteps(s.p, s.v.ageDays, s.v).map(stepText),
    };
  });

  // The flagged omission list, ranked by the same fitted value so the reader
  // sees the biggest omission first — but never board rows.
  excludedAboveFloor.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && (p.mcap_usd as number) > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      mcap_tvl_ratio: round4((p.mcap_usd as number) / p.tvl_usd),
    }));

  const tokenRecorded = snapshot.protocols.filter((p) => p.mcap_usd !== null).length;
  // Strictly pre-token: no market cap, no CoinGecko id, no symbol — the
  // house rule's own test. (Market cap alone is looser: 272 further rows
  // carry a gecko id or a symbol but no market cap, so they record a token
  // even though no value is attached to it.)
  const strictPreToken = snapshot.protocols.filter((p) => isPreToken(p)).length;
  const accounting: Accounting = {
    total: snapshot.protocols.length,
    tokenRecorded,
    tokenIndicated: snapshot.protocols.length - strictPreToken,
    tokenUsable: fit.trainN + fit.trimmedN,
    tokenBadMcap: fit.badMcapN,
    noToken: strictPreToken,
    visibleExcluded: snapshot.protocols.filter((p) => isPreToken(p) && visibleExclusion(p) !== null).length,
    visibleExcludedByReason: reasons,
    visiblePassers,
    aboveFloorNotWatchlist,
    belowFloorPassers,
    familyExcludedBelowFloor,
    boardRows: board.length,
    watchlistSize: snapshot.watchlist.length,
    watchlistCovered: board.filter((r) => r.on_watchlist).length,
  };

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'radar-fitted-1',
    fit,
    accounting,
    board_size: board.length,
    live_size: live.length,
    rows: board,
    live,
    excludedAboveFloor,
  };
  return { board, radar, accounting };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) return `row ${i + 1} does not fall below row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network.
 *  Indented one value per line: the dossier's text shows a file up to its
 *  last complete line, so a single-line dump would show nothing of the
 *  data at all, while this shows the fit, the accounting and the top rows. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar, null, 1)};\n`;
}
