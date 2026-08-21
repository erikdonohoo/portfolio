#!/usr/bin/env node
/**
 * Cost basis across the Stellar and Solana wallets.
 *
 * The question this answers: of the USD sitting in these wallets today, how much did I
 * actually put in, and how much did the positions earn?
 *
 * That means separating money crossing the boundary of the two wallets from money moving
 * around inside them. Swaps, Blend deposits and withdrawals, borrows and repayments all
 * churn balances without changing what you are worth. Only three things move the needle:
 * an external deposit, an external withdrawal, and gains.
 *
 * Transfers between the two wallets (the CCTP bridge, mostly) are internal too, so an
 * outflow on one chain that reappears on the other is matched up and cancelled rather
 * than counted as a withdrawal plus a fresh deposit.
 *
 * History is cached under .ledger/ so a re-run only fetches what is new. Both chains are
 * append-only, so the cache is a pure prefix of the truth and never needs invalidating.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '.ledger');

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const warnings = [];
const warn = (msg) => warnings.push(msg);

// Stellar is full of zero and near-zero spam payments; ignore anything below this.
const DUST = 0.001;

/* ---------------------------------------------------------------- cache */

function cachePath(name) {
  return join(CACHE_DIR, `${name}.json`);
}

function loadCache(name, fallback) {
  const path = cachePath(name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveCache(name, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(name), `${JSON.stringify(value, null, 2)}\n`);
}

/* ---------------------------------------------------------------- http */

async function getJson(url, init, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return await res.json();
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) {
        throw new Error(`${url} -> ${res.status}`);
      }
      lastError = new Error(`${url} -> ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(500 * 2 ** i);
  }
  throw lastError;
}

const rpc = async (method, params) => {
  const body = await getJson(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

/* ---------------------------------------------------------------- stellar */

/**
 * Horizon paging is cursor based and stable, so the newest cached cursor is a safe
 * resume point: records already seen can never change or be reordered.
 */
async function refreshStellar(account, onProgress) {
  const name = `stellar-${account.slice(0, 8)}`;
  const cache = loadCache(name, { account, cursor: undefined, records: [] });
  const before = cache.records.length;

  let url =
    `${HORIZON}/accounts/${account}/payments?order=asc&limit=200` +
    (cache.cursor ? `&cursor=${cache.cursor}` : '');

  while (url) {
    const page = await getJson(url);
    const records = page._embedded?.records ?? [];
    if (!records.length) break;
    for (const r of records) {
      cache.records.push({
        id: r.id,
        type: r.type,
        at: r.created_at,
        tx: r.transaction_hash,
        from: r.from ?? r.funder,
        to: r.to ?? r.account,
        asset: r.asset_code ?? (r.asset_type === 'native' ? 'XLM' : undefined),
        issuer: r.asset_issuer,
        amount: r.amount ?? r.starting_balance,
        sourceAsset: r.source_asset_code ?? (r.source_asset_type === 'native' ? 'XLM' : undefined),
        sourceAmount: r.source_amount,
      });
      cache.cursor = r.paging_token;
    }
    onProgress?.(`stellar ${account.slice(0, 8)}: ${cache.records.length} records`);
    if (records.length < 200) break;
    url = page._links?.next?.href;
  }

  saveCache(name, cache);
  return { account, total: cache.records.length, added: cache.records.length - before };
}

/**
 * Soroban moves value without producing a payment record Horizon will put an amount on,
 * so a bridge arrival is invisible in /payments. Effects do carry it. These are used only
 * to match transfers between your own wallets, not to classify external flows, because
 * effects also fire for every swap leg and Blend interaction.
 */
async function refreshStellarEffects(account, onProgress) {
  const name = `stellar-effects-${account.slice(0, 8)}`;
  const cache = loadCache(name, { account, cursor: undefined, credits: [] });
  const before = cache.credits.length;

  let url =
    `${HORIZON}/accounts/${account}/effects?order=asc&limit=200` +
    (cache.cursor ? `&cursor=${cache.cursor}` : '');

  while (url) {
    const page = await getJson(url);
    const records = page._embedded?.records ?? [];
    if (!records.length) break;
    for (const e of records) {
      cache.cursor = e.paging_token;
      if (e.type !== 'account_credited' && e.type !== 'account_debited') continue;
      const amount = Number(e.amount ?? 0);
      if (!Number.isFinite(amount) || amount < DUST) continue;
      cache.credits.push({
        at: e.created_at,
        dir: e.type === 'account_credited' ? 'in' : 'out',
        asset: e.asset_code ?? (e.asset_type === 'native' ? 'XLM' : e.asset_type),
        amount,
      });
    }
    onProgress?.(`stellar effects ${account.slice(0, 8)}: ${cache.credits.length}`);
    if (records.length < 200) break;
    url = page._links?.next?.href;
  }

  saveCache(name, cache);
  return { account: `${account} (effects)`, total: cache.credits.length, added: cache.credits.length - before };
}

/* ---------------------------------------------------------------- solana */

/**
 * Per-transaction balance deltas for the owner, which is all the classifier needs and is
 * far smaller than the raw transactions. Signatures are walked newest first, stopping at
 * the newest one already cached.
 */
async function refreshSolana(owner, onProgress) {
  const name = `solana-${owner.slice(0, 8)}`;
  const cache = loadCache(name, { owner, newestSignature: undefined, events: [] });
  const before = cache.events.length;

  const fresh = [];
  let cursor;
  outer: while (true) {
    const page = await rpc('getSignaturesForAddress', [
      owner,
      { limit: 1000, ...(cursor ? { before: cursor } : {}) },
    ]);
    if (!page?.length) break;
    for (const s of page) {
      if (s.signature === cache.newestSignature) break outer;
      fresh.push(s);
    }
    cursor = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }

  const pending = fresh.filter((s) => !s.err).reverse(); // oldest first
  for (const [i, s] of pending.entries()) {
    const tx = await rpc('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]);
    if (!tx) continue;
    const event = solanaDeltas(owner, tx, s);
    if (event) cache.events.push(event);
    if (i % 10 === 0) onProgress?.(`solana ${owner.slice(0, 8)}: ${i + 1}/${pending.length} transactions`);
    await sleep(120); // public RPC is rate limited and this walk is one-time per signature
  }

  if (fresh.length) cache.newestSignature = fresh[0].signature;
  cache.events.sort((a, b) => a.ts - b.ts);
  saveCache(name, cache);
  return { owner, total: cache.events.length, added: cache.events.length - before };
}

function solanaDeltas(owner, tx, sig) {
  const { meta, transaction } = tx;
  if (!meta) return undefined;
  const keys = transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));

  let sol = 0;
  const ownerIndex = keys.indexOf(owner);
  if (ownerIndex >= 0) {
    sol = (meta.postBalances[ownerIndex] - meta.preBalances[ownerIndex]) / 1e9;
  }

  const pre = new Map((meta.preTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => [b.accountIndex, b]));
  const post = new Map((meta.postTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => [b.accountIndex, b]));
  const tokens = {};
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const mint = (post.get(index) ?? pre.get(index)).mint;
    const a = Number(pre.get(index)?.uiTokenAmount?.uiAmountString ?? 0);
    const b = Number(post.get(index)?.uiTokenAmount?.uiAmountString ?? 0);
    const delta = b - a;
    if (Math.abs(delta) > 1e-9) tokens[mint] = (tokens[mint] ?? 0) + delta;
  }

  if (Math.abs(sol) < 1e-7 && !Object.keys(tokens).length) return undefined;
  return { ts: sig.blockTime, sig: sig.signature, fee: meta.fee / 1e9, sol, tokens };
}

/**
 * Solana identifies assets by mint, and a mint means nothing to the matcher or the price
 * lookup. Jupiter resolves them to symbols, which is also what portfolio.mjs uses, so the
 * two tools name assets the same way.
 */
async function refreshMints(owners, onProgress) {
  const cache = loadCache('mints', {});
  const seen = new Set();
  for (const owner of owners) {
    const events = loadCache(`solana-${owner.slice(0, 8)}`, { events: [] }).events;
    for (const e of events) for (const mint of Object.keys(e.tokens)) seen.add(mint);
  }
  const missing = [...seen].filter((m) => !(m in cache));
  if (!missing.length) return { account: 'mints', total: Object.keys(cache).length, added: 0 };

  for (let i = 0; i < missing.length; i += 20) {
    const group = missing.slice(i, i + 20);
    try {
      const body = await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${group.join(',')}`);
      for (const token of body ?? []) if (token?.id && token?.symbol) cache[token.id] = token.symbol;
    } catch {
      // leave unresolved; the report will show the truncated mint and flag it as unpriced
    }
    for (const m of group) if (!(m in cache)) cache[m] = null;
    onProgress?.(`mints: ${Object.keys(cache).length} resolved`);
  }
  saveCache('mints', cache);
  return { account: 'mints', total: Object.keys(cache).length, added: missing.length };
}

/* ---------------------------------------------------------------- valuation */

const STABLES = new Set(['USDC', 'USDT', 'EURC']);
const COINGECKO_ID = { XLM: 'stellar', SOL: 'solana' };

// Tokens pegged to a fiat currency: price them off the FX rate for the day, not a market.
const FIAT_PEGGED = { MXNE: 'MXN', MXNe: 'MXN' };

const ETHERFUSE_API = process.env.ETHERFUSE_API_URL ?? 'https://api.etherfuse.com';

// Symbols whose series has already been pulled fresh this run.
const refetched = new Set();

// The free CoinGecko tier rejects bursts, and these lookups are permanently cacheable, so
// a slow first run is a better trade than a silently unpriced flow.
const COINGECKO_SPACING_MS = Number(process.env.COINGECKO_SPACING_MS ?? 6000);
let lastCoingecko = 0;

/**
 * Etherfuse publishes a full daily series per bond, so its tokens can be priced exactly on
 * the day rather than approximated. tokenPrice is in the bond's own currency and
 * usdExchangeRate converts it, which is the same arithmetic the pool oracle does.
 * The whole series arrives in one unpaginated response, so it is fetched once and cached.
 */
async function etherfuseSeries(symbol, { force = false } = {}) {
  const cached = loadCache(`etherfuse-${symbol}`, undefined);
  if (cached && !force) return cached;

  const mints = loadCache('etherfuse-mints', undefined) ?? (await refreshEtherfuseMints());
  const mint = mints[symbol];
  if (!mint) return undefined;

  const body = await getJson(`${ETHERFUSE_API}/lookup/bonds/history/${mint}`);
  const series = (body?.historyRange ?? [])
    .map((e) => {
      const fiat = Number(e.tokenPrice);
      const fx = Number(e.usdExchangeRate);
      if (!Number.isFinite(fiat) || !Number.isFinite(fx) || fx <= 0) return undefined;
      return { date: String(e.date).slice(0, 10), usd: fiat / fx };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  saveCache(`etherfuse-${symbol}`, series);
  return series;
}

async function refreshEtherfuseMints() {
  const body = await getJson(`${ETHERFUSE_API}/lookup/tokens/cost`);
  const mints = {};
  for (const [symbol, token] of Object.entries(body ?? {})) {
    if (token?.token_mint) mints[symbol] = token.token_mint;
  }
  saveCache('etherfuse-mints', mints);
  return mints;
}

// A weekend or holiday gap is normal and carrying the last price forward is right. A gap
// wider than this means the series ends before the date being asked about, which is a
// cache that predates the flow rather than a real gap.
const SERIES_STALE_DAYS = 3;

/**
 * Last observation on or before the date, with how stale that observation is. Reports the
 * gap rather than deciding what to do about it, because the fix for a stale series is to
 * refetch it, and only the caller knows whether that has already been tried.
 */
function seriesPriceOn(series, isoDate) {
  let best;
  for (const point of series) {
    if (point.date > isoDate) break;
    best = point;
  }
  if (!best) return { usd: undefined, staleDays: Infinity };
  return {
    usd: best.usd,
    staleDays: (Date.parse(isoDate) - Date.parse(best.date)) / 86400000,
    endsAt: best.date,
  };
}

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/**
 * Historical price straight off the SDEX, via Horizon's trade aggregations. This is the
 * venue a Stellar balance can actually be sold on, it has no rate limit, and it can be
 * asked for the hour a transfer happened rather than a whole day's average. Falls back to
 * the day when that hour had no trades, and returns undefined when the pair never traded.
 */
async function sdexPriceAt(asset, issuer, at) {
  const base = issuer
    ? `base_asset_type=credit_alphanum${asset.length > 4 ? 12 : 4}&base_asset_code=${asset}&base_asset_issuer=${issuer}`
    : 'base_asset_type=native';
  const counter =
    `counter_asset_type=credit_alphanum4&counter_asset_code=USDC&counter_asset_issuer=${USDC_ISSUER}`;

  const ms = Date.parse(at);
  for (const resolution of [3600000, 86400000]) {
    const start = Math.floor(ms / resolution) * resolution;
    const url =
      `${HORIZON}/trade_aggregations?${base}&${counter}` +
      `&resolution=${resolution}&start_time=${start}&end_time=${start + resolution}&order=asc&limit=1`;
    try {
      const body = await getJson(url);
      const record = body._embedded?.records?.[0];
      // avg is volume weighted across the bucket, which is the fairest single number for
      // a transfer that happened somewhere inside it.
      const avg = Number(record?.avg);
      if (Number.isFinite(avg) && avg > 0) return avg;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Coinbase's public candles need no key and go back years, unlike CoinGecko's free tier
// which refuses anything older than 365 days. That cap is why every 2024 flow priced at $0.
const COINBASE_PRODUCT = { SOL: 'SOL-USD', XLM: 'XLM-USD', BTC: 'BTC-USD', ETH: 'ETH-USD' };

async function coinbasePriceAt(symbol, at) {
  const product = COINBASE_PRODUCT[symbol];
  if (!product) return undefined;
  const ms = Date.parse(at);
  for (const granularity of [3600, 86400]) {
    const span = granularity * 1000;
    const start = Math.floor(ms / span) * span;
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles` +
      `?start=${new Date(start).toISOString()}&end=${new Date(start + span).toISOString()}` +
      `&granularity=${granularity}`;
    try {
      const rows = await getJson(url);
      // [time, low, high, open, close, volume]. Typical price is the closest single-number
      // analogue to the volume-weighted average used for the SDEX.
      const row = rows?.[0];
      if (row) {
        const typical = (Number(row[1]) + Number(row[2]) + Number(row[4])) / 3;
        if (Number.isFinite(typical) && typical > 0) return typical;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function fiatPriceOn(currency, isoDate) {
  const body = await getJson(`https://api.frankfurter.dev/v1/${isoDate}?base=USD&symbols=${currency}`);
  const rate = body?.rates?.[currency];
  return rate ? 1 / rate : undefined;
}

/**
 * USD price for an asset on a given day. Stablecoins are taken at par; everything else
 * needs a historical quote, cached forever because a past day's price never changes.
 * Returns undefined rather than guessing, so unpriced flows can be reported as such.
 */
async function priceOn(symbol, at, issuer) {
  if (STABLES.has(symbol)) return 1;
  const isoDate = at.slice(0, 10);
  // Keyed to the hour, because the SDEX lookup is hourly and a price at 02:00 is not the
  // same as one at 20:00 on a volatile day.
  const key = `${symbol}:${at.slice(0, 13)}`;
  const cache = loadCache('prices', {});
  if (key in cache && cache[key] !== null) return cache[key];

  const remember = (usd) => {
    cache[key] = usd ?? null;
    saveCache('prices', cache);
    return usd;
  };

  // Etherfuse bonds carry an exact daily price, so prefer it over anything else. The
  // endpoint returns the whole series unpaginated, so a date the cache does not reach is
  // just a cache written before that date existed: refetch rather than give up. Once per
  // symbol per run, since one refetch brings the series current for every date.
  try {
    let series = await etherfuseSeries(symbol);
    if (series?.length) {
      let hit = seriesPriceOn(series, isoDate);
      if (hit.staleDays > SERIES_STALE_DAYS && !refetched.has(symbol)) {
        refetched.add(symbol);
        series = await etherfuseSeries(symbol, { force: true });
        hit = seriesPriceOn(series, isoDate);
      }
      if (hit.usd !== undefined && hit.staleDays <= SERIES_STALE_DAYS) return remember(hit.usd);
      if (hit.usd !== undefined) {
        // Still short after a fresh pull, so the API genuinely has nothing nearer.
        warn(
          `${symbol} history reaches ${hit.endsAt} but ${isoDate} was needed ` +
          `(${Math.round(hit.staleDays)} days), so that flow is unpriced`,
        );
      }
    }
  } catch (e) {
    warn(`${symbol} history lookup failed: ${e.message}`);
  }

  const pegged = FIAT_PEGGED[symbol] ?? FIAT_PEGGED[symbol.toUpperCase()];
  if (pegged) {
    try {
      return remember(await fiatPriceOn(pegged, isoDate));
    } catch {
      return remember(undefined);
    }
  }

  // The SDEX is where a Stellar-held asset actually trades, so prefer it over an
  // off-network aggregate, and it has no rate limit to run into.
  if (issuer || symbol === 'XLM') {
    const sdex = await sdexPriceAt(symbol, issuer, at);
    if (sdex !== undefined) return remember(sdex);
  }

  const coinbase = await coinbasePriceAt(symbol, at);
  if (coinbase !== undefined) return remember(coinbase);

  const id = COINGECKO_ID[symbol];
  if (!id) return remember(undefined);
  const [y, m, d] = isoDate.split('-');
  const since = Date.now() - lastCoingecko;
  if (since < COINGECKO_SPACING_MS) await sleep(COINGECKO_SPACING_MS - since);
  lastCoingecko = Date.now();
  try {
    const body = await getJson(
      `https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${m}-${y}&localization=false`,
    );
    const usd = body?.market_data?.current_price?.usd;
    if (usd === undefined) warn(`coingecko has no ${symbol} price for ${isoDate}`);
    return remember(usd);
  } catch (e) {
    // A fetch failure and a genuinely unknown price are different things, and treating
    // them the same is how a rate limit turns into a silently wrong total.
    warn(`coingecko lookup failed for ${symbol} on ${isoDate}: ${e.message}`);
    return undefined;
  }
}

/* ---------------------------------------------------------------- classification */

/**
 * Only two things on Stellar move value across the wallet boundary: a plain payment to or
 * from someone else, and the account's initial funding. Path payments are self-to-self
 * swaps, and Soroban invocations are Blend or the bridge, whose value either stays in the
 * portfolio or lands in the other wallet. Horizon reports the latter with no amount at
 * all, which is a good hint they are not payments in the ordinary sense.
 */
function stellarFlows(cache) {
  const account = cache.account;
  const flows = [];
  for (const r of cache.records) {
    const amount = Number(r.amount ?? 0);
    if (!Number.isFinite(amount) || amount < DUST) continue;

    if (r.type === 'create_account' && r.to === account) {
      flows.push({ chain: 'stellar', at: r.at, dir: 'in', asset: r.asset ?? 'XLM', issuer: r.issuer, amount, other: r.from, tx: r.tx });
      continue;
    }
    if (r.type !== 'payment') continue;
    const other = r.to === account ? r.from : r.to;
    if (other === account) continue; // self payment
    flows.push({
      chain: 'stellar',
      at: r.at,
      dir: r.to === account ? 'in' : 'out',
      asset: r.asset ?? 'XLM',
      issuer: r.issuer,
      amount,
      other,
      tx: r.tx,
    });
  }
  return flows;
}

/**
 * On Solana the same idea has to be inferred from balance deltas, since there is no
 * payment/swap distinction in the data. A transaction that moves one asset down and
 * another up is a swap or a bridge burn; one that only moves an asset up is a deposit.
 * SOL is netted against the fee so paying for gas does not read as a withdrawal.
 */
function solanaFlows(cache, mintSymbols) {
  const flows = [];
  for (const e of cache.events) {
    const at = new Date(e.ts * 1000).toISOString();
    const moves = [];
    // Undo the fee, then ignore what is left if it is rent-sized. Closing a token account
    // refunds a fraction of a SOL, and that refund riding along with a real USDC transfer
    // would otherwise make the whole transaction look like a swap.
    const sol = e.sol + e.fee;
    const SOL_NOISE = 0.03;
    if (Math.abs(sol) > SOL_NOISE) moves.push({ asset: 'SOL', amount: sol });
    for (const [mint, delta] of Object.entries(e.tokens)) {
      const symbol = mintSymbols[mint] || mint.slice(0, 6);
      if (Math.abs(delta) > DUST) moves.push({ asset: symbol, amount: delta, mint });
    }
    if (!moves.length) continue;

    const ups = moves.filter((m) => m.amount > 0);
    const downs = moves.filter((m) => m.amount < 0);
    const kind = ups.length && downs.length ? 'swap' : ups.length ? 'in' : 'out';
    if (kind === 'swap') continue; // value neutral inside the wallet

    for (const m of moves) {
      flows.push({
        chain: 'solana',
        at,
        dir: kind,
        asset: m.asset,
        amount: Math.abs(m.amount),
        mint: m.mint,
        tx: e.sig,
      });
    }
  }
  return flows;
}

/**
 * A withdrawal on one chain that reappears on the other shortly after is the same money
 * moving between wallets, not a withdrawal plus a deposit. Matched pairs cancel.
 */
function matchCrossWallet(flows, { windowHours = 6, tolerance = 0.02 } = {}) {
  const outs = flows.filter((f) => f.dir === 'out');
  const ins = flows.filter((f) => f.dir === 'in');
  const matched = new Set();
  const pairs = [];

  for (const out of outs) {
    const candidate = ins.find(
      (i) =>
        !matched.has(i) &&
        i.chain !== out.chain &&
        i.asset === out.asset &&
        Math.abs(i.amount - out.amount) / out.amount <= tolerance &&
        Math.abs(new Date(i.at) - new Date(out.at)) <= windowHours * 3600 * 1000 &&
        new Date(i.at) >= new Date(out.at),
    );
    if (candidate) {
      matched.add(candidate);
      matched.add(out);
      pairs.push({ out, in: candidate });
    }
  }
  return { pairs, internal: matched };
}

/* ---------------------------------------------------------------- main */

const USAGE = `
ledger - what you put in versus what the wallets are worth now

usage: node ledger.mjs [options]

  --refresh          fetch new history into .ledger/ before reporting
  --flows            list every external flow instead of just the summary
  --current <usd>    override today's value (default: run portfolio.mjs --json)
  --json             machine-readable output
  -h, --help         this text

History is cached in .ledger/ (gitignored). Both chains are append-only, so a refresh
only fetches what happened since the last run.
`.trim();

/**
 * Today's value, split the same way the flows are. Blend positions are Stellar contracts,
 * so they belong to the Stellar side even though they are not wallet balances.
 */
async function currentValue() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('node', [join(HERE, 'portfolio.mjs'), '--json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  const byChain = { stellar: 0, solana: 0 };
  for (const section of report.sections) {
    const chain = /^Solana/.test(section.title) ? 'solana' : 'stellar';
    byChain[chain] += section.rows.reduce((sum, r) => sum + r.usd, 0);
  }
  return { total: report.totalUsd, byChain };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const config = JSON.parse(readFileSync(join(HERE, 'wallets.json'), 'utf8'));
  // Progress uses carriage returns to overwrite in place, which is only meaningful on a
  // terminal. Piped or redirected, it would just be noise in the captured output.
  const log = (msg) => {
    if (process.stderr.isTTY) process.stderr.write(`\r${msg.padEnd(70)}`);
  };

  if (args.includes('--refresh')) {
    const fetched = [];
    for (const account of config.stellar ?? []) {
      fetched.push(await refreshStellar(account, log));
      fetched.push(await refreshStellarEffects(account, log));
    }
    for (const owner of config.solana ?? []) fetched.push(await refreshSolana(owner, log));
    fetched.push(await refreshMints(config.solana ?? [], log));

    // Bond series are append-only too, but the endpoint has no cursor: it returns the
    // whole thing. So a refresh pulls it again rather than trusting a cache that would
    // otherwise silently stop at the day it was first written.
    const mints = await refreshEtherfuseMints();
    for (const symbol of Object.keys(mints)) {
      if (!existsSync(cachePath(`etherfuse-${symbol}`))) continue;
      const before = loadCache(`etherfuse-${symbol}`, [])?.length ?? 0;
      const series = await etherfuseSeries(symbol, { force: true });
      fetched.push({
        account: `etherfuse ${symbol}`,
        total: series?.length ?? 0,
        added: Math.max(0, (series?.length ?? 0) - before),
      });
      log(`etherfuse ${symbol}: ${series?.length ?? 0} points`);
    }

    if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(72)}\r`);
    console.log('cache');
    for (const f of fetched) {
      const added = f.added > 0 ? `  +${f.added} new` : '  up to date';
      console.log(`  ${(f.account ?? f.owner).padEnd(46)} ${String(f.total).padStart(5)}${added}`);
    }
    console.log('');
  }

  // Gather every flow that crosses the boundary of the wallets we track.
  const mintSymbols = loadCache('mints', {});
  let flows = [];
  for (const account of config.stellar ?? []) {
    const cache = loadCache(`stellar-${account.slice(0, 8)}`, undefined);
    if (!cache) throw new Error(`no cached history for ${account}, run with --refresh`);
    flows.push(...stellarFlows(cache));
  }
  for (const owner of config.solana ?? []) {
    const cache = loadCache(`solana-${owner.slice(0, 8)}`, undefined);
    if (!cache) throw new Error(`no cached history for ${owner}, run with --refresh`);
    flows.push(...solanaFlows(cache, mintSymbols));
  }

  // Money moving between the two wallets is not a contribution.
  const own = new Set([...(config.stellar ?? []), ...(config.solana ?? [])]);
  flows = flows.filter((f) => !own.has(f.other));
  const bridgeCandidates = [];
  for (const account of config.stellar ?? []) {
    const fx = loadCache(`stellar-effects-${account.slice(0, 8)}`, undefined);
    for (const c of fx?.credits ?? []) {
      bridgeCandidates.push({ chain: 'stellar', at: c.at, dir: c.dir, asset: c.asset, amount: c.amount, viaEffect: true });
    }
  }
  const { pairs, internal } = matchCrossWallet([...flows, ...bridgeCandidates]);
  const external = flows.filter((f) => !internal.has(f));

  // Value each one on the day it happened.
  const unpriced = [];
  for (const f of external) {
    const price = await priceOn(f.asset, f.at, f.issuer);
    if (price === undefined) {
      unpriced.push(f);
      f.usd = 0;
    } else {
      f.usd = f.amount * price;
      f.price = price;
    }
  }

  const deposits = external.filter((f) => f.dir === 'in');
  const withdrawals = external.filter((f) => f.dir === 'out');
  const inUsd = deposits.reduce((s, f) => s + f.usd, 0);
  const outUsd = withdrawals.reduce((s, f) => s + f.usd, 0);
  const net = inUsd - outUsd;

  const currentIndex = args.indexOf('--current');
  const value = currentIndex >= 0
    ? { total: Number(args[currentIndex + 1]), byChain: undefined }
    : await currentValue();
  const now = value.total;
  const gain = now - net;

  // Per chain, a transfer between your own wallets is a real contribution to the receiving
  // side and a real withdrawal from the sending side. They cancel in the total, which is
  // what makes the two halves add back up to it.
  for (const pair of pairs) {
    const price = await priceOn(pair.out.asset, pair.out.at, pair.out.issuer);
    pair.usd = (price ?? 0) * pair.out.amount;
  }
  const perChain = {};
  for (const chain of ['stellar', 'solana']) {
    const inFlows = deposits.filter((f) => f.chain === chain);
    const outFlows = withdrawals.filter((f) => f.chain === chain);
    const bridgedIn = pairs.filter((p) => p.in.chain === chain).reduce((s, p) => s + p.usd, 0);
    const bridgedOut = pairs.filter((p) => p.out.chain === chain).reduce((s, p) => s + p.usd, 0);
    const contributed =
      inFlows.reduce((s, f) => s + f.usd, 0) - outFlows.reduce((s, f) => s + f.usd, 0) + bridgedIn - bridgedOut;
    // Money bridged out came back to you on the other chain, so for judging a single
    // chain it counts alongside a withdrawal: value that left this leg intact.
    const putIn = inFlows.reduce((s, f) => s + f.usd, 0) + bridgedIn;
    const tookOut = outFlows.reduce((s, f) => s + f.usd, 0) + bridgedOut;
    const worth = value.byChain?.[chain];
    perChain[chain] = {
      putInUsd: putIn,
      tookOutUsd: tookOut,
      bridgedInUsd: bridgedIn,
      bridgedOutUsd: bridgedOut,
      netContributedUsd: contributed,
      currentUsd: worth,
      // What a leg returned is what you got back out of it plus what is still sitting there.
      gainUsd: worth === undefined ? undefined : tookOut + worth - putIn,
      returnPct: worth === undefined || putIn <= 0 ? undefined : ((tookOut + worth - putIn) / putIn) * 100,
    };
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      deposits, withdrawals, crossWalletTransfers: pairs, unpriced,
      depositedUsd: inUsd, withdrawnUsd: outUsd, netContributedUsd: net,
      currentUsd: now, gainUsd: gain,
      returnPct: inUsd > 0 ? ((outUsd + now - inUsd) / inUsd) * 100 : undefined,
      gainOnNetContributedPct: net > 0 ? (gain / net) * 100 : undefined,
      byChain: perChain,
    }, null, 2));
    return 0;
  }

  const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Always signed: a bare "4.20%" next to a negative dollar figure reads as a gain.
  const pct = (n) => (n === undefined ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

  if (args.includes('--flows')) {
    console.log('External flows');
    for (const f of [...external].sort((a, b) => a.at.localeCompare(b.at))) {
      console.log(
        `  ${f.at.slice(0, 10)}  ${f.dir === 'in' ? 'IN ' : 'OUT'}  ${f.amount.toLocaleString('en-US', { maximumFractionDigits: 6 }).padStart(14)} ${f.asset.padEnd(8)} ` +
        `${usd(f.usd).padStart(12)}  ${f.chain}`,
      );
    }
    console.log('');
  }

  if (pairs.length) {
    console.log(`Transfers between your own wallets (not counted): ${pairs.length}`);
    for (const p of pairs) {
      console.log(`  ${p.out.at.slice(0, 10)}  ${p.out.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${p.out.asset}  ${p.out.chain} -> ${p.in.chain}`);
    }
    console.log('');
  }

  // Same formula as the per-chain rows, so the parts add up to the whole: what you got
  // back plus what you still hold, against everything you ever put in.
  const returnPct = inUsd > 0 ? ((outUsd + now - inUsd) / inUsd) * 100 : undefined;
  console.log(`put in             ${usd(inUsd).padStart(14)}   ${deposits.length} transfers in`);
  console.log(`taken out          ${usd(outUsd).padStart(14)}   ${withdrawals.length} transfers out`);
  console.log(`worth today        ${usd(now).padStart(14)}`);
  console.log('');
  console.log(`${gain < 0 ? 'loss' : 'gain'}               ${usd(gain).padStart(14)}   ${pct(returnPct)}`);
  // Not "at risk": the whole balance is exposed, gains included. This is how much of your
  // own money has not come back out, which is the cost basis for what is still there.
  console.log(`your money still in${usd(net).padStart(13)}   put in, less what you took back out`);

  if (value.byChain) {
    console.log('');
    console.log(
      '  by chain'.padEnd(17) + 'put in'.padStart(13) + 'taken out'.padStart(13) +
      'worth today'.padStart(14) + 'gain/loss'.padStart(13) + '   return',
    );
    for (const [chain, c] of Object.entries(perChain)) {
      const suspect = unpriced.filter((f) => f.chain === chain);
      const flag = suspect.length ? `  <- ${suspect.length} unpriced flow(s), see below` : '';
      console.log(
        `  ${chain.padEnd(15)}${usd(c.putInUsd).padStart(13)}${usd(c.tookOutUsd).padStart(13)}` +
        `${usd(c.currentUsd).padStart(14)}${usd(c.gainUsd).padStart(13)}   ${pct(c.returnPct)}${flag}`,
      );
    }
    const bridged = pairs.reduce((s, p) => s + p.usd, 0);
    if (bridged) {
      console.log('');
      console.log(`  ${usd(bridged)} bridged solana to stellar counts as taken out of one leg and put`);
      console.log('  into the other, so a chain is judged on what it returned, not what it still holds.');
    }
  }

  if (unpriced.length) {
    const inCount = unpriced.filter((f) => f.dir === 'in').length;
    const outCount = unpriced.length - inCount;
    console.log('');
    console.log(`no historical price for ${unpriced.length} flow(s), counted as $0:`);
    for (const f of unpriced) {
      console.log(`  ${f.at.slice(0, 10)}  ${f.dir === 'in' ? 'IN ' : 'OUT'}  ${f.amount} ${f.asset} (${f.chain})`);
    }
    console.log('');
    // Direction matters more than count. Value that entered at $0 and left at full price is
    // pure fabricated profit, and the size of the lie is exactly the missing valuation.
    console.log('  *** the gain above is not reliable ***');
    if (inCount) {
      console.log(`  ${inCount} inflow(s) counted as $0. Real money that entered as nothing and left as`);
      console.log('  something shows up as profit that was never earned, so the gain is OVERSTATED.');
    }
    if (outCount) {
      console.log(`  ${outCount} outflow(s) counted as $0, which pushes the gain the other way, DOWN.`);
    }
    console.log('  Price these flows, or exclude the assets, before trusting the percentage.');
  }
  if (warnings.length) {
    console.log('');
    console.log('Warnings:');
    for (const w of [...new Set(warnings)]) console.log(`  ${w}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nledger: ${e.message}`);
    process.exit(1);
  },
);
