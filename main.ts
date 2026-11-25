// Token Launch Radar — entry for make.fun's token-radar-01 bounty.
//
// One Node 22 program, the standard library only. It reads the sealed snapshot at /input/snapshot.json,
// prices every protocol that records no token, and writes:
//
//   /output/board.json      the ranked board the gate reads (rank, implied value, farm plan per row)
//   /output/data.js         the dashboard's whole dataset, as one script (window.RADAR)
//   /output/dashboard/      the static page (index.html, app.css, app.js), copied from this repository
//   /output/screenshots/    the three screenshots, copied from this repository
//   /output/dossier.json    what the judge reads, written with buildDossier from vendor/makefun-board.ts
//
// The value model is calibrated from the snapshot itself: a protocol's implied value is its TVL
// multiplied by the median market-cap-to-TVL multiple of the live tokens in its own category, then by a
// seven-day momentum factor and a tenure factor. No protocol is named anywhere in the code. A second
// score, launch pressure, states how likely a launch looks from the same five fields; it never touches
// the implied value.
//
// Outside the grader's container:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/token-radar-01-kit/input/snapshot.json
// Screenshots (a browser is needed, never required by the graded run):
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot> --shots
// Browse it:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot> --serve 8080

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// ------------------------------------------------------------------ arguments

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

// ------------------------------------------------------------------ the snapshot

export interface Protocol {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

class SnapshotError extends Error {}

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const protocols: Protocol[] = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return {
    as_of: o.as_of,
    source: typeof o.source === 'string' ? o.source : '',
    floor_usd: o.floor_usd as number,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ------------------------------------------------------------------ the model

/** Every number the value model uses, stated on the page and in board.json. */
export const MODEL = {
  version: 'peer-calibrated/3',
  momentum_weight: 0.3,
  momentum_floor: -50,
  momentum_cap: 150,
  momentum_mult_floor: 0.85,
  momentum_mult_cap: 1.45,
  tenure_floor: 0.72,
  tenure_range: 0.28,
  tenure_days: 1095,
  unknown_age_days: 365,
  peer_min_samples: 4,
  peer_mult_floor: 0.05,
  peer_mult_cap: 8,
  value_cap_usd: 100_000_000_000_000,
} as const;

/** The launch pressure at which the page calls a protocol a hot launch (its own scale, not the gate's). */
export const HOT_PRESSURE = 60;

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** A protocol records a token when DefiLlama carries either of its two token fields. */
export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** DefiLlama's version marker: a name ending in a release belongs to another protocol's pool. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories whose members are a bridged, staked or custodial form of an asset that already trades. */
const FORMED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name carrying one of these words is a wrapped or staked product, whatever its record says. */
const FORMED_NAME = /\b(wrapped|staked|staking)\b/i;
/** A protocol named after an exchange is that exchange's product, not an independent launch. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a protocol is a subject the radar may rank: it records no token, and it is not the bridged,
 * wrapped or staked form of a coin that already trades. This is the house's own watchlist rule, applied
 * to the whole snapshot rather than only above its floor: WBTC is Bitcoin on Ethereum and Binance staked
 * ETH is ETH in a staking product, so neither is a protocol waiting on a launch of its own. Every
 * protocol the house's watchlist names passes it, which is why the board covers the watchlist by construction.
 */
function isSubject(p: Protocol): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && FORMED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (FORMED_NAME.test(p.name)) return false;
  return !EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix));
}

/** Whole days from the snapshot's day to the day DefiLlama began tracking the protocol. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export interface CategoryMultiple {
  category: string;
  multiple: number;
  samples: number;
  /** Whether the multiple comes from the category's own live tokens or from the market-wide median. */
  basis: 'category' | 'market';
}

export interface Calibration {
  market: { multiple: number; samples: number };
  categories: CategoryMultiple[];
  /** Every live protocol whose market cap and TVL give the ratio, counted once. */
  instruments: number;
}

/**
 * The peer multiple: what the market pays for TVL, in the protocol's own category. Every live-token
 * protocol in the snapshot with a market cap and a TVL contributes market cap / TVL; a category needs
 * MODEL.peer_min_samples of them to speak for itself, and the market-wide median stands in otherwise.
 */
function calibrate(protocols: Protocol[]): Calibration {
  const ratios: { category: string | null; ratio: number }[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.mcap_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0.005 || ratio > 200) continue;
    ratios.push({ category: p.category, ratio });
  }
  const marketMult = clamp(median(ratios.map((r) => r.ratio)), MODEL.peer_mult_floor, MODEL.peer_mult_cap);
  const byCategory = new Map<string, number[]>();
  for (const r of ratios) {
    if (r.category === null) continue;
    const list = byCategory.get(r.category);
    if (list === undefined) byCategory.set(r.category, [r.ratio]);
    else list.push(r.ratio);
  }
  const categories: CategoryMultiple[] = [...byCategory.entries()]
    .map(([category, xs]) => {
      const own = xs.length >= MODEL.peer_min_samples;
      const multiple = clamp(own ? median(xs) : marketMult, MODEL.peer_mult_floor, MODEL.peer_mult_cap);
      return { category, multiple: round(multiple, 4), samples: xs.length, basis: own ? ('category' as const) : ('market' as const) };
    })
    .sort((a, b) => b.samples - a.samples || (a.category < b.category ? -1 : 1));
  return { market: { multiple: round(marketMult, 4), samples: ratios.length }, categories, instruments: ratios.length };
}

function peerMultiple(cal: Calibration, category: string | null): CategoryMultiple {
  if (category !== null) {
    const hit = cal.categories.find((c) => c.category === category);
    if (hit !== undefined && hit.basis === 'category') return hit;
  }
  return { category: category ?? 'unclassified', multiple: cal.market.multiple, samples: cal.market.samples, basis: 'market' };
}

export interface Scored {
  protocol: Protocol;
  implied: number;
  age: number | null;
  momentum: number;
  momentum_mult: number;
  tenure_mult: number;
  peer: CategoryMultiple;
  multiple: number;
  pressure: number;
  pressure_parts: { size: number; category: number; tenure: number; momentum: number };
}

/** The value one protocol's launch would carry, if its record stays as it is. */
function score(p: Protocol, asOf: string, cal: Calibration): Scored {
  const age = ageDays(asOf, p.listed_at);
  const growth = clamp(p.change_7d ?? 0, MODEL.momentum_floor, MODEL.momentum_cap);
  const momentumMultiplier = clamp(1 + (growth / 100) * MODEL.momentum_weight, MODEL.momentum_mult_floor, MODEL.momentum_mult_cap);
  const ageForModel = age ?? MODEL.unknown_age_days;
  const tenureMultiplier = MODEL.tenure_floor + (clamp(ageForModel, 0, MODEL.tenure_days) / MODEL.tenure_days) * MODEL.tenure_range;
  const peer = peerMultiple(cal, p.category);
  const raw = p.tvl_usd * peer.multiple * momentumMultiplier * tenureMultiplier;
  const implied = Math.max(1, Math.min(MODEL.value_cap_usd, Math.round(raw)));
  return {
    protocol: p,
    implied,
    age,
    momentum: round(growth, 4),
    momentum_mult: round(momentumMultiplier, 4),
    tenure_mult: round(tenureMultiplier, 4),
    peer,
    multiple: round(implied / Math.max(1, p.tvl_usd), 4),
    pressure: 0,
    pressure_parts: { size: 0, category: 0, tenure: 0, momentum: 0 },
  };
}

/**
 * Launch pressure, 0 to 100: how likely a launch looks from the same five fields the value model reads,
 * never from a name. It is the size of the protocol against the whole pre-token field, the share of its
 * own category that already trades a token, how long it has run without one, and its recent growth. It is
 * shown beside the implied value and drives the page's hot filter; it never changes the implied value.
 */
function pressureFor(p: Protocol, age: number | null, sizeRank: number, catTokenRate: Map<string, number>): { score: number; parts: { size: number; category: number; tenure: number; momentum: number } } {
  const size = clamp(sizeRank, 0, 1);
  const category = clamp(catTokenRate.get(p.category ?? '') ?? 0.5, 0, 1);
  const tenure = clamp((age ?? MODEL.unknown_age_days) / 1095, 0, 1);
  const momentum = clamp(((p.change_7d ?? 0) + 15) / 45, 0, 1);
  const score = 100 * (0.32 * size + 0.24 * category + 0.24 * tenure + 0.2 * momentum);
  return {
    score: Math.round(clamp(score, 0, 100)),
    parts: { size: round(size, 3), category: round(category, 3), tenure: round(tenure, 3), momentum: round(momentum, 3) },
  };
}

/** How much of one category already trades a token: the share of its protocols DefiLlama records a token for. */
function categoryTokenRate(protocols: Protocol[]): Map<string, number> {
  const total = new Map<string, number>();
  const live = new Map<string, number>();
  for (const p of protocols) {
    if (p.category === null) continue;
    total.set(p.category, (total.get(p.category) ?? 0) + 1);
    if (recordsToken(p)) live.set(p.category, (live.get(p.category) ?? 0) + 1);
  }
  const rate = new Map<string, number>();
  for (const [c, n] of total) rate.set(c, (live.get(c) ?? 0) / n);
  return rate;
}

// ------------------------------------------------------------------ the farm plan

function chainName(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvl: number): number {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 200;
  if (tvl >= 1e8) return 150;
  if (tvl >= 2e7) return 100;
  return 50;
}

function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The one action that makes a wallet count, in the protocol's own words, from its category. */
function actionFor(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit')) {
    return `Supply $${capital} of USDC to ${n} on ${chain} and borrow $${Math.round(capital * 0.4)} of a second asset against it, so both the supply and the borrow side see your wallet.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged')) {
    return `Provide $${capital} of liquidity to ${n}'s deepest pool on ${chain}, then swap once through that same pool so the volume counts to the pair.`;
  }
  if (c.includes('bridge') || c.includes('canonical')) {
    return `Bridge $${capital} of USDC to ${chain} through ${n}, then deploy the bridged funds in ${n}'s app and bridge a part back a week later.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of ${chain}'s native asset through ${n} and keep the receipt token in the same wallet, unswapped.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${n} and carry one small hedged position for a week before you close it.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} into ${n} on ${chain} and take one position on each side of a market you understand.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} into one of ${n}'s vaults on ${chain} and keep the vault shares in the wallet that deposited.`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint or buy $${capital} of ${n}'s yield asset on ${chain} and hold it through one full distribution.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${n} on ${chain} for a pool you actually hold, and keep the policy to its expiry.`;
  }
  if (c.includes('stable')) {
    return `Mint $${capital} of ${n}'s stable asset on ${chain} against collateral you already hold, and hold the mint for a month.`;
  }
  if (c.includes('farm') || c.includes('launchpad') || c.includes('nft')) {
    return `Use $${capital} on ${n} on ${chain} the way its own docs describe: one deposit, one transaction, no routed third-party contract.`;
  }
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open through the next month.`;
}

/**
 * A protocol's farm plan: six steps, each with what it costs and how long it takes, derived from the
 * protocol's own record (category, first chain, TVL, age). No step is written per name.
 */
export interface FarmPlan {
  steps: string[];
  /** What the plan costs and takes, summed from the steps so the page can state one budget. */
  budget: { capital_usd: number; gas_low_usd: number; gas_high_usd: number; minutes: number; days: number; weeks: number };
}

function farmPlan(p: Protocol, age: number | null): FarmPlan {
  const chain = chainName(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDays(age);
  const weeks = hold >= 45 ? 6 : 4;
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    `Open a wallet on ${chain} that holds only the capital you plan to farm, fund it with $${capital + 20} of USDC, and keep its seed phrase off this machine. Cost: about $1 to $2 of gas to fund it. Time: 5 minutes.`,
    actionFor(p, capital, chain) + ` Cost: $${capital} of capital and roughly $${gas} of gas. Time: 15 minutes to set up.`,
    `Repeat one qualifying action each week for ${weeks} weeks: add to the position, borrow and repay, swap through the protocol, or vote with the position you already hold. Cost: about $2 to $4 of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days, so that several weekly readings of ${p.name}'s TVL see your wallet and not a single snapshot. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`,
    `Before you withdraw, read ${p.name}'s own docs and points page for the launch terms, and claim only from the domain those docs name. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
    `Record the wallet, the dates, the capital and every transaction hash in one log, so the position can be repeated or unwound in a single sitting. Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return {
    steps,
    budget: {
      capital_usd: capital,
      gas_low_usd: 3 + gas + weeks * 2,
      gas_high_usd: 4 + gas + weeks * 4,
      minutes: 5 + 15 + weeks * 10 + 10 + 5,
      days: hold,
      weeks,
    },
  };
}

// ------------------------------------------------------------------ the board

export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    version: string;
    peer_multiple: number;
    peer_basis: 'category' | 'market';
    peer_samples: number;
    momentum_pct: number;
    momentum_multiplier: number;
    tenure_multiplier: number;
  };
  launch_pressure: number;
  farm_steps: string[];
  plan: FarmPlan['budget'];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  peer_multiple: number;
  peer_basis: 'category' | 'market';
  peer_samples: number;
  momentum_multiplier: number;
  tenure_multiplier: number;
  launch_pressure: number;
  watchlist: boolean;
  farm_steps: string[];
  plan: FarmPlan['budget'];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  generated_by: string;
  model: typeof MODEL;
  calibration: { market: { multiple: number; samples: number }; instruments: number; categories: CategoryMultiple[] };
  stats: {
    protocols: number;
    pretoken: number;
    set_aside: number;
    live: number;
    live_shown: number;
    watchlist: number;
    watchlist_covered: number;
    rows: number;
    early_rows: number;
    implied_total: number;
    implied_median: number;
    tvl_total: number;
    hot: number;
    hot_threshold: number;
    oldest_days: number;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const cal = calibrate(snapshot.protocols);
  const rates = categoryTokenRate(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const tokenless = snapshot.protocols.filter((p) => !recordsToken(p));
  const subjects = tokenless.filter(isSubject);
  // The size component of launch pressure: where the protocol's TVL falls in the pre-token field.
  const tvlAscending = subjects.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const sizeRank = (tvl: number): number => {
    let lo = 0;
    let hi = tvlAscending.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tvlAscending[mid]! < tvl) lo = mid + 1;
      else hi = mid;
    }
    return tvlAscending.length <= 1 ? 1 : lo / (tvlAscending.length - 1);
  };

  const scored = subjects.map((p) => {
    const s = score(p, snapshot.as_of, cal);
    const pr = pressureFor(p, s.age, sizeRank(p.tvl_usd), rates);
    s.pressure = pr.score;
    s.pressure_parts = pr.parts;
    return s;
  });
  scored.sort((a, b) => b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => {
    const plan = farmPlan(s.protocol, s.age);
    return ({
    rank: i + 1,
    slug: s.protocol.slug,
    name: s.protocol.name,
    category: s.protocol.category,
    chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd,
    change_7d: s.protocol.change_7d,
    mcap_usd: s.protocol.mcap_usd,
    listed_at: s.protocol.listed_at,
    gecko_id: s.protocol.gecko_id,
    symbol: s.protocol.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      version: MODEL.version,
      peer_multiple: s.peer.multiple,
      peer_basis: s.peer.basis,
      peer_samples: s.peer.samples,
      momentum_pct: s.momentum,
      momentum_multiplier: s.momentum_mult,
      tenure_multiplier: s.tenure_mult,
    },
    launch_pressure: s.pressure,
    farm_steps: plan.steps,
    plan: plan.budget,
  });
  });

  const rows: RadarRow[] = board.map((r, i) => {
    const s = scored[i]!;
    return {
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      multiple: s.multiple,
      peer_multiple: s.peer.multiple,
      peer_basis: s.peer.basis,
      peer_samples: s.peer.samples,
      momentum_multiplier: s.momentum_mult,
      tenure_multiplier: s.tenure_mult,
      launch_pressure: r.launch_pressure,
      watchlist: watch.has(r.slug),
      farm_steps: r.farm_steps,
      plan: r.plan,
    };
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => recordsToken(p) && p.category !== 'CEX' && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 60)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd === null ? null : round(p.mcap_usd / Math.max(1, p.tvl_usd), 4),
    }));

  const implied = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const covered = snapshot.watchlist.filter((s) => board.some((r) => r.slug === s)).length;
  const radar: Radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    generated_by: 'token-radar main.ts',
    model: MODEL,
    calibration: { market: cal.market, instruments: cal.instruments, categories: cal.categories },
    stats: {
      protocols: snapshot.protocols.length,
      pretoken: subjects.length,
      set_aside: tokenless.length - subjects.length,
      live: snapshot.protocols.filter((p) => recordsToken(p)).length,
      live_shown: live.length,
      watchlist: snapshot.watchlist.length,
      watchlist_covered: covered,
      rows: board.length,
      early_rows: board.filter((r) => !watch.has(r.slug)).length,
      implied_total: board.reduce((n, r) => n + r.implied_value_usd, 0),
      implied_median: implied.length === 0 ? 0 : implied[implied.length >> 1]!,
      tvl_total: board.reduce((n, r) => n + r.tvl_usd, 0),
      hot: board.filter((r) => r.launch_pressure >= HOT_PRESSURE).length,
      hot_threshold: HOT_PRESSURE,
      oldest_days: board.reduce((m, r) => Math.max(m, r.age_days ?? 0), 0),
    },
    rows,
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > MODEL.value_cap_usd) return `${r.slug} is past the value cap`;
  }
  return null;
}

// ------------------------------------------------------------------ outputs

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 512 * 1024 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4 * 1024 * 1024 };
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function copyPlainFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** A browser that opens a local file and writes a PNG: --browser, $MAKEFUN_BROWSER, Playwright's cache, then PATH. */
function findBrowser(explicit: string | null): string | null {
  const ok = (p: string): string | null => (p !== '' && existsSync(p) ? p : null);
  if (explicit !== null) return ok(explicit);
  if (process.env.MAKEFUN_BROWSER) return ok(process.env.MAKEFUN_BROWSER);
  const roots = [join(homedir(), '.cache', 'ms-playwright')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).sort().reverse()) {
      if (!dir.startsWith('chromium_headless_shell-')) continue;
      const hit = ok(join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      if (hit !== null) return hit;
    }
    for (const dir of readdirSync(root).sort().reverse()) {
      if (!dir.startsWith('chromium-')) continue;
      const hit = ok(join(root, dir, 'chrome-linux', 'chrome'));
      if (hit !== null) return hit;
    }
  }
  for (const name of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    const hit = ok(name);
    if (hit !== null) return hit;
  }
  return null;
}

interface Shot {
  file: string;
  hash: string;
  note: string;
}

/** The three views the bounty asks for: the board, a protocol's detail view, a filtered view. */
function shotPlan(radar: Radar): Shot[] {
  // The detail view: the protocol under the most launch pressure, so the screen shows the model at work.
  const detail = [...radar.rows].sort((a, b) => b.launch_pressure - a.launch_pressure || a.rank - b.rank)[0]!;
  // The filtered view: the detail protocol's category, narrowed again to hot launches when that leaves rows.
  const inCategory = radar.rows.filter((r) => (r.category ?? '') === (detail.category ?? ''));
  const hotInCategory = inCategory.filter((r) => r.launch_pressure >= HOT_PRESSURE).length;
  const cat = detail.category ?? '';
  const filtered = hotInCategory >= 4 ? `#cat=${encodeURIComponent(cat)}&hot=1` : `#cat=${encodeURIComponent(cat)}`;
  return [
    { file: '1-board.png', hash: '', note: 'the board' },
    { file: '2-detail.png', hash: `#p=${encodeURIComponent(detail.slug)}`, note: `the detail view of ${detail.name}` },
    { file: '3-filtered.png', hash: filtered, note: `the board filtered to ${cat}` },
  ];
}

function capture(browser: string, pageUrl: string, outPng: string): boolean {
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--virtual-time-budget=4000',
    `--screenshot=${outPng}`,
    pageUrl,
  ];
  const r = spawnSync(browser, args, { stdio: 'pipe', timeout: 90_000, env: { ...process.env, HOME: homedir() } });
  if (r.error) {
    process.stderr.write(`token radar: the browser failed: ${String(r.error)}\n`);
    return false;
  }
  return existsSync(outPng) && statSync(outPng).size > 10_000;
}

async function serve(dir: string, port: number): Promise<void> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' ) path = '/dashboard/index.html';
    const full = normalize(join(dir, path));
    if (!full.startsWith(normalize(dir + sep)) || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(full));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  process.stdout.write(`token radar: serving ${join(dir, 'dashboard')} at http://127.0.0.1:${port}/ (ctrl-c to stop)\n`);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
    process.exit(2);
  }
  const out = resolve(arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output'));
  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));

  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  const boardJson = `${JSON.stringify({ model: MODEL, as_of: snapshot.as_of, rows: board })}\n`;
  writeFileSync(join(out, 'board.json'), boardJson);
  writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);
  copyPlainFiles(join(here, 'dashboard'), join(out, 'dashboard'));

  // Screenshots: rendered now when a browser is asked for, otherwise taken from this repository.
  if (hasFlag('shots')) {
    const browser = findBrowser(arg('browser', '') === '' ? null : arg('browser', ''));
    if (browser === null) {
      process.stderr.write('token radar: no browser found: pass --browser <path> or set MAKEFUN_BROWSER\n');
      process.exit(3);
    }
    const shotsDir = join(here, 'screenshots');
    mkdirSync(shotsDir, { recursive: true });
    const page = `file://${join(out, 'dashboard', 'index.html')}`;
    for (const shot of shotPlan(radar)) {
      const file = join(shotsDir, shot.file);
      if (!capture(browser, `${page}${shot.hash}`, file)) {
        process.stderr.write(`token radar: ${shot.file} (${shot.note}) was not written\n`);
        process.exit(3);
      }
      process.stdout.write(`token radar: wrote ${file} (${statSync(file).size} bytes) — ${shot.note}\n`);
    }
  }

  const shots = copyPlainFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: the bounty wants 3\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!PLAIN_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -\n`);
      process.exit(1);
    }
  }

  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));
  const dossierBytes = statSync(join(out, 'dossier.json')).size;
  const boardBytes = statSync(join(out, 'board.json')).size;
  const boardHash = createHash('sha256').update(boardJson).digest('hex').slice(0, 16);

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${radar.stats.pretoken} pre-token, ${snapshot.watchlist.length} on the watchlist (${radar.stats.watchlist_covered} covered)\n` +
      `token radar: ${board.length} rows, implied pool $${radar.stats.implied_total.toLocaleString('en-US')}, median $${radar.stats.implied_median.toLocaleString('en-US')}, ${radar.stats.hot} hot\n` +
      `token radar: wrote board.json (${boardBytes} B, ${boardHash}), data.js, dashboard/ (3 files), screenshots/ (${shots.length}), dossier.json (${dossierBytes} B)\n`,
  );

  if (hasFlag('serve')) await serve(out, Number(arg('port', '8080')));
}

await main();
