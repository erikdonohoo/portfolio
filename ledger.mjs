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
import * as solanaWeb3 from '@solana/web3.js';
import * as stellarSdk from '@stellar/stellar-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '.ledger');

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Associated token address, derived rather than fetched so closed accounts stay reachable. */
function associatedTokenAddress(owner, mint) {
  const { PublicKey } = solanaWeb3;
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()],
    ATA,
  )[0].toBase58();
}

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

async function getJson(url, init, attempts = 7) {
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

// Walking the owner plus every token account multiplies the call count, and the public
// endpoint will not wear a burst. Space them out; the walk is one-time per signature.
const SOLANA_SPACING_MS = Number(process.env.SOLANA_SPACING_MS ?? 220);
let lastSolanaCall = 0;

const rpc = async (method, params) => {
  const since = Date.now() - lastSolanaCall;
  if (since < SOLANA_SPACING_MS) await sleep(SOLANA_SPACING_MS - since);
  lastSolanaCall = Date.now();
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
  const cache = loadCache(name, { account, cursor: undefined, credits: [], trades: [], contracts: [] });
  cache.trades ??= [];
  // Records written before operation ids were captured group by timestamp instead, which
  // merges two operations that landed in the same second. The cursor makes the cache
  // append-only, so the only way to add a field to old rows is to fetch them again.
  const stale =
    cache.contracts === undefined ||
    cache.credits.some((c) => c.tx === undefined) ||
    cache.trades.some((t) => t.op === undefined);
  if (stale) {
    cache.cursor = undefined;
    cache.credits = [];
    cache.trades = [];
    cache.contracts = [];
  }
  const before = cache.credits.length + cache.trades.length;

  let url =
    `${HORIZON}/accounts/${account}/effects?order=asc&limit=200` +
    (cache.cursor ? `&cursor=${cache.cursor}` : '');

  while (url) {
    const page = await getJson(url);
    const records = page._embedded?.records ?? [];
    if (!records.length) break;
    for (const e of records) {
      cache.cursor = e.paging_token;
      // Trades are captured because a filled offer produces nothing else. No payment
      // record, no account_credited, just this. An offer resting on the book and being
      // taken is invisible to every other endpoint, and it is how the wallet acquired
      // 7,548 CETES that the ledger could not otherwise account for.
      if (e.type === 'trade' || e.type === 'liquidity_pool_trade') {
        // The native asset is spelled two ways: order book trades omit the code, AMM trades
        // say "native". Left alone, XLM bought through an AMM lands in a separate bucket and
        // never matches an XLM lot.
        const norm = (spec) => {
          const code = (spec ?? '').split(':')[0];
          return !code || code === 'native' ? 'XLM' : code;
        };
        let sold;
        let bought;
        if (e.type === 'trade') {
          // Order book trades are written from the account's point of view.
          sold = { asset: norm(e.sold_asset_code), amount: Number(e.sold_amount ?? 0) };
          bought = { asset: norm(e.bought_asset_code), amount: Number(e.bought_amount ?? 0) };
        } else {
          // AMM trades are written from the pool's, so they are inverted: what the pool
          // sold is what the account bought. Confirmed against a swap whose direction is
          // known independently from its payment record.
          sold = { asset: norm(e.bought?.asset), amount: Number(e.bought?.amount ?? 0) };
          bought = { asset: norm(e.sold?.asset), amount: Number(e.sold?.amount ?? 0) };
        }
        if (sold.amount > DUST && bought.amount > DUST) {
          cache.trades.push({ at: e.created_at, op: e.id?.split('-')[0], offerId: e.offer_id, sold, bought });
        }
        continue;
      }
      // Who the account moved value with. Horizon puts this on a separate effect from the
      // balance change, so it is kept as its own list and joined by operation id when the
      // movements are built: joining here would break on an operation split across pages.
      // Without it every contract looks alike, and value swapped for a Blend backstop LP
      // share goes on being counted as the USDC it stopped being.
      if (e.type === 'contract_credited' || e.type === 'contract_debited') {
        if (e.contract) {
          cache.contracts.push({
            at: e.created_at,
            op: e.id?.split('-')[0],
            contract: e.contract,
            asset: e.asset_code ?? (e.asset_type === 'native' ? 'XLM' : e.asset_type),
            dir: e.type === 'contract_credited' ? 'to' : 'from',
          });
        }
        continue;
      }
      if (e.type !== 'account_credited' && e.type !== 'account_debited') continue;
      const amount = Number(e.amount ?? 0);
      if (!Number.isFinite(amount) || amount < DUST) continue;
      cache.credits.push({
        at: e.created_at,
        tx: e.id?.split('-')[0],
        dir: e.type === 'account_credited' ? 'in' : 'out',
        asset: e.asset_code ?? (e.asset_type === 'native' ? 'XLM' : e.asset_type),
        amount,
      });
    }
    onProgress?.(`stellar effects ${account.slice(0, 8)}: ${cache.credits.length}`);
    if (records.length < 200) break;
    url = page._links?.next?.href;
  }

  // The cursor advances per effect, so an operation split across two fetches can leave
  // duplicates. Effect ids are unique, so dropping repeats is exact rather than heuristic.
  const seen = new Set();
  cache.contracts = cache.contracts.filter((c) => {
    const k = `${c.op}|${c.contract}|${c.asset}|${c.dir}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  saveCache(name, cache);
  const total = cache.credits.length + cache.trades.length;
  return { account: `${account} (effects)`, total, added: total - before };
}

/**
 * What the account paid the network. Fees appear on no operation, payment or effect: the
 * only place they exist is the transaction record, so an XLM balance rebuilt from effects
 * alone is always high by the total ever spent on fees. Soroban makes that worse than it
 * sounds, since one invocation can cost several orders of magnitude more than a payment.
 */
async function refreshStellarFees(account, onProgress) {
  const name = `stellar-fees-${account.slice(0, 8)}`;
  const cache = loadCache(name, { account, cursor: undefined, charges: [] });
  const before = cache.charges.length;

  let url =
    `${HORIZON}/accounts/${account}/transactions?order=asc&limit=200&include_failed=true` +
    (cache.cursor ? `&cursor=${cache.cursor}` : '');

  while (url) {
    const page = await getJson(url);
    const records = page._embedded?.records ?? [];
    if (!records.length) break;
    for (const t of records) {
      cache.cursor = t.paging_token;
      // A fee bump or a sponsored transaction is charged to someone else's balance.
      if ((t.fee_account ?? t.source_account) !== account) continue;
      const fee = Number(t.fee_charged ?? 0) / 1e7;
      if (!Number.isFinite(fee) || fee <= 0) continue;
      cache.charges.push({ at: t.created_at, tx: t.hash, fee });
    }
    onProgress?.(`stellar fees ${account.slice(0, 8)}: ${cache.charges.length}`);
    if (records.length < 200) break;
    url = page._links?.next?.href;
  }

  const seen = new Set();
  cache.charges = cache.charges.filter((c) => (seen.has(c.tx) ? false : seen.add(c.tx)));
  saveCache(name, cache);
  return {
    account: `${account} (fees)`,
    total: cache.charges.length,
    added: cache.charges.length - before,
  };
}

/* ---------------------------------------------------------------- blend */

// Blend's submit() request codes, from the SDK's RequestType enum. The number is the only
// thing that distinguishes supplying collateral from borrowing against it, and the two mean
// opposite things for cost basis, so guessing is not an option.
// Blend speaks in Stellar Asset Contract addresses; the rest of the ledger speaks in
// symbols. These are the reserves across the configured pools.
const SAC_SYMBOL = {
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: 'USDC',
  CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV: 'CETES',
  CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR: 'USTRY',
  CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS: 'TESOURO',
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: 'XLM',
  CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: 'EURC',
};

const BLEND_REQUEST = {
  0: 'supply',
  1: 'withdraw',
  2: 'supply',   // SupplyCollateral
  3: 'withdraw', // WithdrawCollateral
  4: 'borrow',
  5: 'repay',
};

/**
 * What each Soroban invocation actually did in a Blend pool.
 *
 * Horizon's /payments reports these with no amount, which is why the lot engine had no
 * record of assets arriving out of a pool. The envelope has everything: submit(from,
 * spender, to, requests) where each request carries an asset, an amount and a type code.
 * Decoding it is the difference between "7,000 XLM appeared from nowhere" and a basis.
 */
async function refreshBlendOps(account, onProgress) {
  const name = `blend-ops-${account.slice(0, 8)}`;
  const cache = loadCache(name, { account, ops: {}, skipped: [] });
  const before = Object.keys(cache.ops).length;

  const records = loadCache(`stellar-${account.slice(0, 8)}`, { records: [] }).records;
  const hashes = [...new Set(records.filter((r) => r.type === 'invoke_host_function').map((r) => r.tx))];
  const pending = hashes.filter((h) => !(h in cache.ops) && !cache.skipped.includes(h));

  for (const [i, hash] of pending.entries()) {
    try {
      const body = await getJson(`${HORIZON}/transactions/${hash}`);
      const tx = stellarSdk.TransactionBuilder.fromXDR(body.envelope_xdr, stellarSdk.Networks.PUBLIC);
      const requests = [];
      for (const op of tx.operations) {
        if (op.type !== 'invokeHostFunction') continue;
        let invocation;
        try {
          invocation = op.func.invokeContract();
        } catch {
          continue; // upload or create, not a contract call
        }
        const fn = invocation.functionName().toString();
        if (fn === 'claim') {
          // Claiming emissions mints BLND out of nothing you paid for. Without this the
          // engine sees BLND being sold that it never saw arrive.
          requests.push({
            pool: stellarSdk.Address.fromScAddress(invocation.contractAddress()).toString(),
            kind: 'claim',
            contract: 'BLND',
            amount: 0, // the amount lands in the effects, not the arguments
          });
          continue;
        }
        if (fn !== 'submit') continue;
        const pool = stellarSdk.Address.fromScAddress(invocation.contractAddress()).toString();
        const args = invocation.args();
        const list = stellarSdk.scValToNative(args[3]) ?? [];
        for (const r of list) {
          const kind = BLEND_REQUEST[Number(r.request_type)];
          if (!kind) continue;
          requests.push({ pool, kind, contract: r.address, amount: Number(r.amount) / 1e7 });
        }
      }
      if (requests.length) cache.ops[hash] = { at: body.created_at, requests };
      else cache.skipped.push(hash); // a soroban call that was not a Blend submit
    } catch (e) {
      cache.skipped.push(hash);
    }
    if (i % 10 === 0) onProgress?.(`blend ops ${account.slice(0, 8)}: ${i + 1}/${pending.length}`);
  }

  saveCache(name, cache);
  return { account: `${account} (blend ops)`, total: Object.keys(cache.ops).length, added: Object.keys(cache.ops).length - before };
}

/* ---------------------------------------------------------------- solana */

/**
 * Per-transaction balance deltas for the owner, which is all the classifier needs and is
 * far smaller than the raw transactions. Signatures are walked newest first, stopping at
 * the newest one already cached.
 */
/**
 * Every address whose history has to be walked for one owner.
 *
 * Walking the owner address alone is not enough, and this is the subtle part: an SPL
 * transfer into your wallet names the sender, the sender's token account and your token
 * account. Your wallet address appears nowhere in it. So getSignaturesForAddress(owner)
 * is structurally blind to money arriving, which is the worst possible thing to miss when
 * the question is "how much did I put in". Token accounts have to be walked too.
 */
async function solanaAddressesToWalk(owner, cache) {
  const addresses = new Set([owner]);
  for (const programId of [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ]) {
    try {
      const res = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
      for (const a of res?.value ?? []) addresses.add(a.pubkey);
    } catch {
      // a missing token program is not fatal; the owner walk still runs
    }
  }
  // Accounts that have since been closed no longer show up above, but any mint already
  // seen has a derivable associated address, so past history stays reachable.
  const mints = new Set(cache.events.flatMap((e) => Object.keys(e.tokens)));
  for (const mint of mints) {
    try {
      addresses.add(associatedTokenAddress(owner, mint));
    } catch {
      // not a valid mint, skip
    }
  }
  return [...addresses];
}

async function refreshSolana(owner, onProgress) {
  const name = `solana-${owner.slice(0, 8)}`;
  const cache = loadCache(name, { owner, newestSignature: undefined, events: [], seen: [] });
  const before = cache.events.length;
  const seen = new Set(cache.seen ?? []);

  const addresses = await solanaAddressesToWalk(owner, cache);
  onProgress?.(`solana ${owner.slice(0, 8)}: walking ${addresses.length} addresses`);

  const fresh = [];
  for (const address of addresses) {
    let cursor;
    while (true) {
      const page = await rpc('getSignaturesForAddress', [
        address,
        { limit: 1000, ...(cursor ? { before: cursor } : {}) },
      ]);
      if (!page?.length) break;
      for (const s of page) {
        if (seen.has(s.signature)) continue;
        seen.add(s.signature);
        fresh.push(s);
      }
      cursor = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
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

  // A cache written before token accounts were walked has no `seen` set, so every
  // signature looks new and the whole history is re-walked. That is exactly what should
  // happen, since the old walk was missing transactions, but the events it already holds
  // would be appended a second time. Deduplicate by signature so re-walking is safe to
  // repeat, whatever state the cache was left in.
  const bySignature = new Map();
  for (const e of cache.events) bySignature.set(e.sig, e);
  cache.events = [...bySignature.values()].sort((a, b) => a.ts - b.ts);
  cache.seen = [...seen];
  delete cache.newestSignature; // superseded: one marker cannot describe several addresses
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
  if (STABLES.has(symbol)) return { usd: 1 };
  const isoDate = at.slice(0, 10);
  // Keyed to the hour, because the SDEX lookup is hourly and a price at 02:00 is not the
  // same as one at 20:00 on a volatile day.
  const key = `${symbol}:${at.slice(0, 13)}`;
  const cache = loadCache('prices', {});
  if (key in cache && cache[key] !== null) return { usd: cache[key] };

  const remember = (usd, reason) => {
    cache[key] = usd ?? null;
    saveCache('prices', cache);
    return { usd, reason: usd === undefined ? reason : undefined };
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
      const usd = await fiatPriceOn(pegged, isoDate);
      return remember(usd, 'failed');
    } catch {
      return remember(undefined, 'failed');
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
  // Nothing anywhere quotes this asset. That is what a worthless token looks like, and it
  // is a different situation from a source that exists and did not answer.
  if (!id) return remember(undefined, 'no-source');
  const [y, m, d] = isoDate.split('-');
  const since = Date.now() - lastCoingecko;
  if (since < COINGECKO_SPACING_MS) await sleep(COINGECKO_SPACING_MS - since);
  lastCoingecko = Date.now();
  try {
    const body = await getJson(
      `https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${m}-${y}&localization=false`,
    );
    const usd = body?.market_data?.current_price?.usd;
    return remember(usd, 'no-source');
  } catch (e) {
    // A fetch failure and a genuinely unknown price are different things, and treating
    // them the same is how a rate limit turns into a silently wrong total.
    return remember(undefined, 'failed');
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
/**
 * Same classification as solanaFlows, but nothing is dropped. Discarding internal activity
 * is right for the arithmetic and wrong for understanding it: a swap misread as a transfer
 * is invisible in a list that only shows transfers.
 */
function solanaActivity(cache, mintSymbols) {
  const rows = [];
  for (const e of cache.events) {
    const at = new Date(e.ts * 1000).toISOString();
    const moves = [];
    const sol = e.sol + e.fee;
    if (Math.abs(sol) > 0.03) moves.push({ asset: 'SOL', amount: sol });
    for (const [mint, delta] of Object.entries(e.tokens)) {
      if (Math.abs(delta) > DUST) moves.push({ asset: mintSymbols[mint] || mint.slice(0, 6), amount: delta });
    }
    const ups = moves.filter((m) => m.amount > 0);
    const downs = moves.filter((m) => m.amount < 0);
    const kind = !moves.length ? 'fee only' : ups.length && downs.length ? 'swap' : ups.length ? 'in' : 'out';
    rows.push({ chain: 'solana', at, kind, moves, tx: e.sig });
  }
  return rows;
}

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
 * The same asset leaving and coming back on the same chain, weeks apart and within a few
 * percent. On these wallets that is an issuance rollover: the maturing bond goes back and
 * the next issuance arrives. Counted as a withdrawal plus a deposit it inflates both sides,
 * which leaves the gain unchanged but distorts the percentages, so it is reported rather
 * than merged: the timing is far too loose to net out automatically without guessing.
 */
function sameChainRoundTrips(external, { maxDays = 60, tolerance = 0.08 } = {}) {
  const pairs = [];
  const used = new Set();
  for (const out of external.filter((f) => f.dir === 'out')) {
    const match = external.find(
      (f) =>
        f.dir === 'in' && !used.has(f) && f.chain === out.chain && f.asset === out.asset &&
        Date.parse(f.at) > Date.parse(out.at) &&
        (Date.parse(f.at) - Date.parse(out.at)) / 86400000 <= maxDays &&
        Math.abs(f.amount - out.amount) / out.amount <= tolerance,
    );
    if (match) {
      used.add(match);
      used.add(out);
      pairs.push({ out, in: match });
    }
  }
  return pairs;
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

/* ---------------------------------------------------------------- lots */

/**
 * Swaps as seen from the wallet: one asset down, another up, in one transaction. These are
 * value neutral for the total, which is why the aggregate model discards them, but they are
 * exactly where a holding's cost basis is set. Buying CETES with USDC gives the CETES a
 * basis; selling it later realises against that basis. Without them a lot engine has no
 * idea what anything cost.
 *
 * They are also price observations. A trade of 100 USDC for 1,819 GIGADICK says GIGADICK
 * was worth $0.055 at that moment, which is the only price a token like that will ever have.
 */
function solanaSwaps(cache, mintSymbols) {
  const swaps = [];
  for (const e of cache.events) {
    const moves = [];
    const sol = e.sol + e.fee;
    if (Math.abs(sol) > 0.03) moves.push({ asset: 'SOL', amount: sol });
    for (const [mint, delta] of Object.entries(e.tokens)) {
      if (Math.abs(delta) > DUST) moves.push({ asset: mintSymbols[mint] || mint.slice(0, 6), amount: delta });
    }
    const ups = moves.filter((m) => m.amount > 0);
    const downs = moves.filter((m) => m.amount < 0);
    if (!ups.length || !downs.length) continue;
    swaps.push({
      chain: 'solana',
      at: new Date(e.ts * 1000).toISOString(),
      tx: e.sig,
      gave: downs.map((m) => ({ asset: m.asset, amount: -m.amount })),
      got: ups.map((m) => ({ asset: m.asset, amount: m.amount })),
    });
  }
  return swaps;
}

/**
 * Every movement of the Stellar wallet's balances, grouped by transaction.
 *
 * Effects are the only complete record: payments miss Soroban entirely, and both payments
 * and account_credited miss a filled offer. Grouping by transaction is what lets a debit
 * and a credit in the same transaction be read as one movement rather than two unrelated
 * ones.
 */
function stellarMovements(effectsCache) {
  const byOp = new Map();
  const contractByOp = new Map();
  for (const c of effectsCache.contracts ?? []) if (c.op) contractByOp.set(c.op, c.contract);
  for (const c of effectsCache.credits ?? []) {
    const k = c.tx ?? c.at;
    const group = byOp.get(k) ?? { at: c.at, op: k, moves: [], fromBalance: false, hasTrade: false };
    group.fromBalance = true;
    group.contract ??= contractByOp.get(k);
    group.moves.push({ asset: c.asset, amount: c.dir === 'in' ? c.amount : -c.amount });
    byOp.set(k, group);
  }
  // A trade in an operation that produced no balance effect is a filled offer, which is
  // the one case nothing else records.
  //
  // The test is whether the group holds *balance* effects, not whether a group exists at
  // all. An offer taken in two bites is two operations one second apart, and the earlier
  // version treated the second bite as redundant with the first and dropped it. That is
  // how 5,183 CETES arrived with no basis and 188 XLM were sold twice.
  for (const tr of effectsCache.trades ?? []) {
    const k = tr.op ?? tr.at;
    const group = byOp.get(k);
    if (group?.fromBalance) { group.hasTrade = true; continue; }
    const g = group ?? { at: tr.at, op: k, moves: [], fromBalance: false, hasTrade: false };
    g.hasTrade = true;
    g.moves.push({ asset: tr.sold.asset, amount: -tr.sold.amount });
    g.moves.push({ asset: tr.bought.asset, amount: tr.bought.amount });
    byOp.set(k, g);
  }
  // Several effects for one asset in one operation net out: a path payment through two
  // hops of the same asset is one movement, not two.
  return [...byOp.values()]
    .map((g) => {
      const net = new Map();
      for (const m of g.moves) net.set(m.asset, (net.get(m.asset) ?? 0) + m.amount);
      return { ...g, moves: [...net].map(([asset, amount]) => ({ asset, amount })).filter((m) => Math.abs(m.amount) > DUST) };
    })
    .filter((g) => g.moves.length)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The effects cache, refusing a shape the readers below cannot use.
 *
 * A cursor makes these caches append-only, so a field added to the fetcher never reaches
 * rows already written. The fetcher handles that by refetching from scratch, but only a
 * refresh runs the fetcher: read straight from a stale cache and the movement builder
 * quietly falls back to grouping by timestamp, which merges operations that landed in the
 * same second and loses one of them. Silently wrong beats loudly wrong for nobody.
 */
function loadStellarEffects(account, { refreshed }) {
  const name = `stellar-effects-${account.slice(0, 8)}`;
  const cache = loadCache(name, undefined);
  if (!cache) throw new Error(`no cached effects for ${account}, run without --cached`);
  const stale =
    cache.contracts === undefined ||
    (cache.credits ?? []).some((c) => c.tx === undefined) ||
    (cache.trades ?? []).some((t) => t.op === undefined);
  if (stale && !refreshed) {
    throw new Error(
      `.ledger/${name}.json was written by an older version and is missing operation ids.\n` +
      '  Run without --cached once and it will refetch itself.',
    );
  }
  return cache;
}

/**
 * Every DEX trade on the account, from trade effects rather than payment records.
 *
 * Path payments produce trade effects as well, so this is a superset and using both would
 * double count. It is also the only way to see an offer of yours being filled: that emits
 * trade effects and nothing else at all.
 */
function stellarSwaps(effectsCache) {
  return (effectsCache.trades ?? []).map((tr) => ({
    chain: 'stellar',
    at: tr.at,
    tx: tr.offerId,
    gave: [{ asset: tr.sold.asset, amount: tr.sold.amount }],
    got: [{ asset: tr.bought.asset, amount: tr.bought.amount }],
  }));
}

/**
 * FIFO cost basis across both chains.
 *
 * Realised gain accumulates as lots are closed; unrealised is what is left, marked against
 * today's price. Both sides of a swap are valued at the same USD amount, which is what makes
 * the two models reconcile: realised + unrealised has to equal the aggregate
 * tookOut + worthToday - putIn, and the caller asserts exactly that.
 */
function runLots({ entries, currentPrices, marketValue, opaqueLocations = {} }) {
  const lots = new Map(); // "location:asset" -> [{ at, amount, basisPerUnit }]
  const debts = new Map(); // borrowed positions, same shape, owed rather than held
  const interestUnits = [];
  const disposals = [];
  const issues = [];
  let realised = 0;

  const key = (chain, asset) => `${chain}:${asset}`;
  const open = (chain, asset, at, amount, usdValue) => {
    if (!(amount > 0)) return;
    const list = lots.get(key(chain, asset)) ?? [];
    list.push({ at, amount, basisPerUnit: usdValue / amount });
    lots.set(key(chain, asset), list);
  };

  /** Close `amount` FIFO, realising against `usdValue` of proceeds. */
  const close = (chain, asset, at, amount, usdValue, label, { quiet = false } = {}) => {
    if (!(amount > 0)) return;
    const list = lots.get(key(chain, asset)) ?? [];
    const proceedsPerUnit = usdValue / amount;
    let left = amount;
    let basis = 0;
    while (left > 1e-12 && list.length) {
      const lot = list[0];
      const take = Math.min(lot.amount, left);
      basis += take * lot.basisPerUnit;
      lot.amount -= take;
      left -= take;
      if (lot.amount <= 1e-12) list.shift();
    }
    if (left > 1e-9) {
      // Nothing on hand to close against: the asset arrived by a route this ledger cannot
      // see, so it has no recorded cost and the disposal is all gain. That is not a choice,
      // it is what the aggregate says too. Put-in never rose for units that were never
      // seen arriving, so their proceeds are pure gain there, and charging them at proceeds
      // here instead would leave the two models disagreeing by exactly this amount.
      // The units are still wrong, which is what the issue below and the position check are
      // for: a large one means history is missing, not that you made money.
      if (!quiet) {
        issues.push(`${asset} on ${chain}: disposed ${left.toFixed(6)} more than was ever acquired (${at.slice(0, 10)}), no basis to charge it`);
      }
    }
    lots.set(key(chain, asset), list);
    const gain = usdValue - basis;
    realised += gain;
    disposals.push({ chain, asset, at, amount, proceeds: usdValue, basis, gain, label });
  };

  // Basis is conserved: nothing but a contribution, a withdrawal or a realised gain may
  // change the open basis, and that identity is the whole reason realised and unrealised
  // add up to the aggregate. LEDGER_INVARIANT=1 checks it after every entry and names the
  // one that broke it, which is how a pro-rated repayment and a disposal charged at
  // proceeds were each found to be quietly creating basis.
  const netBasisNow = () => {
    let held = 0;
    for (const list of lots.values()) for (const l of list) held += l.amount * l.basisPerUnit;
    let owed = 0;
    for (const list of debts.values()) for (const l of list) owed += l.amount * l.basisPerUnit;
    return held - owed;
  };
  const auditing = Boolean(process.env.LEDGER_INVARIANT);
  let contributed = 0;
  let leaked = 0;
  for (const e of entries) {
    if (auditing) {
      if (e.kind === 'in') contributed += e.usd ?? 0;
      if (e.kind === 'out') contributed -= e.usd ?? 0;
    }
    if (e.kind === 'in') open(e.chain, e.asset, e.at, e.amount, e.usd);
    else if (e.kind === 'out') close(e.chain, e.asset, e.at, e.amount, e.usd, 'withdrawal');
    else if (e.kind === 'swap') {
      // One trade, one value. Valuing the sides differently would break the reconciliation
      // and quietly book slippage as a gain.
      for (const g of e.gave) close(e.chain, g.asset, e.at, g.amount, e.usd * (g.share ?? 1 / e.gave.length), 'swap');
      for (const g of e.got) open(e.chain, g.asset, e.at, g.amount, e.usd * (g.share ?? 1 / e.got.length));
    } else if (e.kind === 'blend-supply' || e.kind === 'blend-withdraw') {
      // Moving between your wallet and a pool you control realises nothing: the basis
      // travels with the asset. Withdrawing more units than were supplied is interest the
      // position earned, and earned units have no cost, so they carry a zero basis.
      const [fromLoc, toLoc] = e.kind === 'blend-supply'
        ? [e.chain, e.pool]
        : [e.pool, e.chain];
      const list = lots.get(key(fromLoc, e.asset)) ?? [];
      let left = e.amount;
      let basis = 0;
      while (left > 1e-12 && list.length) {
        const lot = list[0];
        const take = Math.min(lot.amount, left);
        basis += take * lot.basisPerUnit;
        lot.amount -= take;
        left -= take;
        if (lot.amount <= 1e-12) list.shift();
      }
      if (left > 1e-9) {
        // Two very different situations look the same here. If the position existed and was
        // merely smaller than the withdrawal, the excess is interest the pool paid, and
        // earned units genuinely have no cost. If there was no position at all, the supply
        // was never captured, and calling that interest mints free money: the units get sold
        // later against a zero basis and the whole proceeds book as profit. So only the
        // first case is interest; the second is missing data, priced at market so it
        // realises nothing.
        const hadPosition = basis > 0;
        if (hadPosition && e.kind === 'blend-withdraw') {
          interestUnits.push({ asset: e.asset, amount: left, at: e.at });
        } else {
          const price = currentPrices[e.asset];
          basis += left * (price ?? 0);
          issues.push(
            `${e.asset}: ${e.kind === 'blend-withdraw' ? 'withdrew' : 'supplied'} ${left.toFixed(4)} ` +
            `at ${e.pool} with no position on record (${e.at.slice(0, 10)})`,
          );
        }
      }
      lots.set(key(fromLoc, e.asset), list);
      open(toLoc, e.asset, e.at, e.amount, basis);
    } else if (e.kind === 'blend-borrow') {
      // You received an asset and took on a debt of equal value. Nothing is earned yet, so
      // the two must net to zero: an asset lot at market, and a liability at the same value.
      open(e.chain, e.asset, e.at, e.amount, e.usd);
      const liabilities = debts.get(key(e.pool, e.asset)) ?? [];
      liabilities.push({ at: e.at, amount: e.amount, basisPerUnit: e.usd / e.amount });
      debts.set(key(e.pool, e.asset), liabilities);
    } else if (e.kind === 'blend-repay') {
      // Handing back the asset closes its lot, which realises whatever happened to the
      // asset itself. Extinguishing the debt realises the other half: repaying more value
      // than was borrowed is interest, and that is a real loss.
      close(e.chain, e.asset, e.at, e.amount, e.usd, 'repay');
      const liabilities = debts.get(key(e.pool, e.asset)) ?? [];
      let left = e.amount;
      let owed = 0;
      while (left > 1e-12 && liabilities.length) {
        const d = liabilities[0];
        const take = Math.min(d.amount, left);
        owed += take * d.basisPerUnit;
        d.amount -= take;
        left -= take;
        if (d.amount <= 1e-12) liabilities.shift();
      }
      debts.set(key(e.pool, e.asset), liabilities);
      // What you handed over is the whole repayment, including the part that met debt the
      // ledger never recorded a borrow for. Pro-rating it to the matched portion made the
      // accrued interest disappear instead of being realised as the loss it is.
      const paid = e.usd;
      const interest = owed - paid; // negative when the debt grew, which is the usual case
      realised += interest;
      if (Math.abs(interest) > 1e-9) {
        disposals.push({
          chain: e.pool, asset: e.asset, at: e.at, amount: e.amount - left,
          proceeds: owed, basis: paid, gain: interest, label: 'debt interest',
        });
      }
    } else if (e.kind === 'to-contract' || e.kind === 'from-contract') {
      // Basis travels; nothing is realised. Value that leaves the wallet for a contract is
      // still yours, and value returning from one was already yours.
      const held = e.pool ?? 'invested';
      const [fromLoc, toLoc] = e.kind === 'to-contract' ? [e.chain, held] : [held, e.chain];
      const list = lots.get(key(fromLoc, e.asset)) ?? [];
      let left = e.amount;
      let basis = 0;
      while (left > 1e-12 && list.length) {
        const lot = list[0];
        const take = Math.min(lot.amount, left);
        basis += take * lot.basisPerUnit;
        lot.amount -= take;
        left -= take;
        if (lot.amount <= 1e-12) list.shift();
      }
      // Coming back with more than went in is interest or emissions: earned units, no cost.
      if (left > 1e-9 && e.kind === 'to-contract') {
        issues.push(`${e.asset}: sent ${left.toFixed(4)} to a contract with no basis on record (${e.at.slice(0, 10)})`);
      }
      lots.set(key(fromLoc, e.asset), list);
      open(toLoc, e.asset, e.at, e.amount, basis);
    } else if (e.kind === 'adjustment') {
      // Something the chain will not tell this wallet about. A liquidation is the case that
      // forced it: the collateral is seized inside someone else's transaction, so it appears
      // in neither your operations nor your effects, and the replay goes on holding a
      // position that is gone. Recorded by hand, it realises against whatever you got for
      // it, which for a seizure is nothing.
      if (e.amount < 0) close(e.chain, e.asset, e.at, -e.amount, e.usd ?? 0, e.note ?? 'adjustment');
      else open(e.chain, e.asset, e.at, e.amount, e.usd ?? 0);
    } else if (e.kind === 'chain-cost') {
      // What the network took, or handed back. Spent on a fee the units are gone and their
      // basis is a realised loss; refunded rent is units arriving free. Either way the
      // aggregate already sees it, because worth today counts the balance that is left.
      if (e.delta < 0) close(e.chain, e.asset, e.at, -e.delta, 0, 'network cost', { quiet: true });
      else open(e.chain, e.asset, e.at, e.delta, 0);
    } else if (e.kind === 'bridge') {
      // Same money, different chain. Carry the basis across rather than realising, except
      // for the part the bridge kept: fewer units arrive than left, and those units are
      // gone for good, so their basis is a realised loss rather than something to carry.
      const list = lots.get(key(e.fromChain, e.asset)) ?? [];
      let left = e.amount;
      let basis = 0;
      while (left > 1e-12 && list.length) {
        const lot = list[0];
        const take = Math.min(lot.amount, left);
        basis += take * lot.basisPerUnit;
        lot.amount -= take;
        left -= take;
        if (lot.amount <= 1e-12) list.shift();
      }
      if (left > 1e-9) basis += left * (e.usd / e.amount);
      lots.set(key(e.fromChain, e.asset), list);
      const received = e.received ?? e.amount;
      const carried = basis * (received / e.amount);
      const fee = basis - carried;
      if (fee > 1e-9) {
        realised -= fee;
        disposals.push({
          chain: e.fromChain, asset: e.asset, at: e.at, amount: e.amount - received,
          proceeds: 0, basis: fee, gain: -fee, label: 'bridge fee',
        });
      }
      open(e.toChain, e.asset, e.at, received, carried);
    }
    if (auditing) {
      const leak = netBasisNow() - (realised + contributed);
      if (Math.abs(leak - leaked) > 0.005) {
        console.error(
          `  basis leak ${(leak - leaked).toFixed(4)}  ${e.at} ${e.kind} ` +
          `${e.asset ?? ''} ${e.amount?.toFixed?.(4) ?? ''}`.trimEnd(),
        );
        leaked = leak;
      }
    }
  }

  if (auditing) console.error(`  basis leak, total ${(netBasisNow() - realised - contributed).toFixed(4)}`);
  let markedValue = 0;
  let openBasis = 0;
  const holdings = [];
  // Location names contain a colon of their own (blend:POOLID), so the asset is whatever
  // follows the LAST one. Splitting from the left silently renamed every pool holding to
  // the pool's id and lost its asset, which is why they all came out unpriceable.
  const splitKey = (k) => [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
  for (const [k, list] of lots) {
    const [chain, asset] = splitKey(k);
    const amount = list.reduce((s, l) => s + l.amount, 0);
    if (amount <= 1e-9) continue;
    const basis = list.reduce((s, l) => s + l.amount * l.basisPerUnit, 0);
    openBasis += basis;
    // A location whose contents were exchanged for something the replay never sees cannot
    // be marked by pricing what went in. Its basis is still exact, so it counts here; only
    // the mark comes from elsewhere, and it is added once per location below.
    if (opaqueLocations[chain] !== undefined) {
      holdings.push({ chain, asset, amount, basis, value: undefined, opaque: true });
      continue;
    }
    const price = currentPrices[asset];
    if (price === undefined) {
      issues.push(`${asset} on ${chain}: holding ${amount.toFixed(6)} with no current price, its own mark is missing`);
      holdings.push({ chain, asset, amount, basis, value: undefined, gain: undefined });
      continue;
    }
    const value = amount * price;
    markedValue += value;
    holdings.push({ chain, asset, amount, basis, value, gain: value - basis });
  }

  // Debt still outstanding is negative value. Marked at today's price so a debt that grew
  // shows as an unrealised loss, which is what an accruing borrow is.
  const locationMarks = [];
  for (const [location, mark] of Object.entries(opaqueLocations)) {
    markedValue += mark;
    const basis = holdings.filter((h) => h.chain === location).reduce((sum, h) => sum + h.basis, 0);
    locationMarks.push({ location, basis, value: mark });
  }

  const outstanding = [];
  let debtBasis = 0;
  for (const [k, list] of debts) {
    const [location, asset] = splitKey(k);
    const amount = list.reduce((s, d) => s + d.amount, 0);
    if (amount <= 1e-9) continue;
    const basis = list.reduce((s, d) => s + d.amount * d.basisPerUnit, 0);
    debtBasis += basis;
    const price = currentPrices[asset];
    outstanding.push({ location, asset, amount, basis, value: price === undefined ? undefined : amount * price });
    if (price !== undefined) markedValue -= amount * price;
  }

  // Unrealised is what today's value exceeds the basis still open, and today's value is the
  // portfolio, not the replay's own marks. This is not a convenience: the replay's basis
  // arithmetic guarantees openBasis - debtBasis = realised + put in - taken out, so
  // defining unrealised this way makes realised + unrealised equal the aggregate gain
  // exactly, for any input. Marking against replay-derived quantities instead made the two
  // models disagree by however much those quantities had drifted from the chain, which is
  // a position error being reported as a valuation error.
  //
  // The drift itself is still worth knowing, so it is measured rather than absorbed:
  // markedValue is what the replay thinks its own holdings are worth, and the gap between
  // that and the portfolio is reported as a position check.
  const netBasis = openBasis - debtBasis;
  const unrealised = marketValue === undefined ? markedValue - netBasis : marketValue - netBasis;

  return {
    realised, unrealised, disposals, holdings, outstanding, interestUnits, issues,
    openBasis, debtBasis, netBasis, markedValue, locationMarks,
  };
}

/* ---------------------------------------------------------------- return */

/**
 * Modified Dietz: a money weighted return that accounts for when each deposit landed, not
 * just how much it was.
 *
 * The plain figure this replaces divides a dollar gain by a dollar of deposits, which says
 * that $100 earning $242 over three years and the same $100 earning it over three months
 * performed identically. Modified Dietz fixes that by weighting each flow by the fraction
 * of the period it was actually invested.
 *
 * The reason it is this and not IRR: IRR solves a polynomial whose root count follows the
 * number of sign changes, and a wallet with dozens of interleaved deposits and withdrawals
 * can admit several answers or one absurd one. A dollar in and two dollars out a day later
 * has an exact IRR around 10^107 percent. Modified Dietz always has exactly one value and
 * needs no solver, which is why it is the industry fallback for irregular flows.
 */
function modifiedDietz(flows, endValue, { startValue = 0, now = Date.now() } = {}) {
  const dated = flows
    .filter((f) => Number.isFinite(f.usd) && f.usd !== 0)
    .map((f) => ({ ms: Date.parse(f.at), amount: f.dir === 'in' ? f.usd : -f.usd }))
    .sort((a, b) => a.ms - b.ms);
  if (!dated.length) return undefined;

  const startMs = dated[0].ms;
  const totalDays = (now - startMs) / 86400000;
  if (totalDays <= 0) return undefined;

  const net = dated.reduce((sum, f) => sum + f.amount, 0);
  // Each flow is credited for the share of the period it was present. A deposit on the
  // last day barely counts toward the capital that produced the return; one on day zero
  // counts fully.
  const weighted = dated.reduce(
    (sum, f) => sum + f.amount * ((now - f.ms) / 86400000 / totalDays),
    0,
  );

  const gain = endValue - startValue - net;
  const averageCapital = startValue + weighted;
  if (!(averageCapital > 0)) return { gain, totalDays, averageCapital, undefinedReason: 'average capital is not positive' };

  const periodReturn = gain / averageCapital;
  return {
    gain,
    totalDays,
    averageCapital,
    periodReturn,
    // Annualising a short window magnifies noise, so it is only offered past a month.
    // Losing more than the average capital gives a return under -100%, and raising a
    // negative base to a fractional power has no real answer. Report nothing rather than NaN.
    annualised:
      totalDays >= 30 && periodReturn > -1
        ? (1 + periodReturn) ** (365 / totalDays) - 1
        : undefined,
  };
}

/* ---------------------------------------------------------------- main */

const USAGE = `
ledger - what you put in versus what the wallets are worth now

usage: node ledger.mjs [options]

By default it fetches what is new and reports everything, including the FIFO cost basis.
The flags below mostly turn work off.

  --cached           report from .ledger/ without fetching. Instant, and the thing to use
                     when an endpoint is down or you only want to re-read the last run
  --summary          skip the cost basis and position check, leaving the aggregate figures
  --flows            also list every external flow, not just the totals
  --activity         also list every transaction and how it was classified, including the
                     ones treated as internal. This is how a misclassification becomes
                     visible
  --trace <loc:asset>  print every entry that moves one holding and the running balance
                     after it, so a position that disagrees with the chain can be walked
                     back to the transaction that broke it. Locations are stellar, solana,
                     blend:<pool>, backstop:<pool> and invested
  --config <path>    wallet config JSON (default: ./wallets.json)
  --current <usd>    override today's value (default: run portfolio.mjs --json)
  --worthless <list> comma separated symbols that really are worth nothing, so they are
                     priced at zero on purpose instead of being reported as unpriced
                     (adjustments for what no endpoint reports, such as a liquidation,
                     go in the config file rather than on the command line)
  --json             machine-readable output, aggregate figures only
  -h, --help         this text

History is cached in .ledger/ (gitignored). Both chains are append-only, so a refresh
only fetches what happened since the last run.

Set LEDGER_INVARIANT=1 to check after every entry that basis was conserved, and name the
entry that broke it. Realised and unrealised only add up to the aggregate gain while that
holds, so this is what to reach for when they do not.
`.trim();

/**
 * Today's value, split the same way the flows are. Blend positions are Stellar contracts,
 * so they belong to the Stellar side even though they are not wallet balances.
 */
async function currentValue(configPath) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const read = async () => {
    // The same wallets, or the report is one set of wallets' history against another set's
    // balances. Reporting a friend's flows against your own portfolio is not a small error.
    const argv = [join(HERE, 'portfolio.mjs'), '--json', '--config', configPath];
    const { stdout } = await promisify(execFile)('node', argv, { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  // Every figure below is `worth today` minus something, so a portfolio that quietly came
  // back short turns the whole report into fiction rather than into an error. A Soroban RPC
  // that rate limits mid run drops a Blend pool and takes a few thousand dollars with it,
  // which reads as a catastrophic loss. Refuse the run instead, after one retry.
  const failed = (r) => (r.warnings ?? []).filter((w) => /failed:/.test(w));
  let report = await read();
  // Soroban public RPC rate limits often enough that one clean read can take a few tries.
  for (let attempt = 1; attempt < 4 && failed(report).length; attempt++) {
    await new Promise((r) => setTimeout(r, attempt * 4000));
    report = await read();
  }
  if (failed(report).length) {
    throw new Error(
      `portfolio.mjs could not read everything, so today's value is incomplete:\n    ` +
      failed(report).join('\n    ') +
      '\n  Re-run once the endpoint is answering.',
    );
  }
  const byChain = { stellar: 0, solana: 0 };
  // Marking holdings with the same prices that produced `worth today`. Using a different
  // source for the two sides guarantees they disagree by whatever the sources disagree by.
  const prices = {};
  // A backstop deposit is not the USDC and BLND that went into it, it is an LP share whose
  // price moves on its own. The replay can follow value into the comet contract but has no
  // way to see what came back out, so the portfolio's figure is the only mark there is.
  const locations = {};
  const lpTokens = {};
  const positions = {};
  for (const section of report.sections) {
    const chain = /^Solana/.test(section.title) ? 'solana' : 'stellar';
    const total = section.rows.reduce((sum, r) => sum + r.usd, 0);
    byChain[chain] += total;
    const poolId = /- (C[A-Z2-7]{55})$/.exec(section.title)?.[1];
    const location = /^Blend backstop/.test(section.title) && poolId ? `backstop:${poolId.slice(0, 8)}`
      : /^Blend/.test(section.title) && poolId ? `blend:${poolId.slice(0, 8)}`
      : chain;
    locations[location] = (locations[location] ?? 0) + total;
    if (section.lpToken) lpTokens[section.lpToken] = location;
    for (const row of section.rows) {
      const symbol = String(row.label).split(/[\s(]/)[0];
      if (row.price !== undefined && symbol) prices[symbol] ??= row.price;
      if (!symbol || row.amount === undefined) continue;
      positions[location] ??= {};
      positions[location][symbol] = {
        amount: (positions[location][symbol]?.amount ?? 0) + row.amount,
        usd: (positions[location][symbol]?.usd ?? 0) + row.usd,
      };
    }
  }
  return { total: report.totalUsd, byChain, prices, locations, lpTokens, positions };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  // A typo used to mean "silently do less": an unrecognised --lots did not fetch, did not
  // report and did not complain. That matters more now the useful flags are the ones that
  // turn work off, where a typo means silently doing more.
  const TAKES_VALUE = new Set(['--config', '--current', '--worthless', '--trace']);
  const KNOWN = new Set([
    ...TAKES_VALUE, '--cached', '--summary', '--flows', '--activity', '--json',
    '--refresh', '--lots', '-h', '--help',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (TAKES_VALUE.has(arg)) { i++; continue; }
    if (!KNOWN.has(arg)) throw new Error(`unknown argument: ${arg}. Run with --help.`);
  }
  // --refresh and --lots are what you want almost every run, so they are what you get.
  // They are still accepted, and still mean what they used to, they are just no longer
  // the difference between a report and half a report.
  const refreshing = !args.includes('--cached');
  const showLots = !args.includes('--summary');

  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : join(HERE, 'wallets.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Progress uses carriage returns to overwrite in place, which is only meaningful on a
  // terminal. Piped or redirected, it would just be noise in the captured output.
  const log = (msg) => {
    if (process.stderr.isTTY) process.stderr.write(`\r${msg.padEnd(70)}`);
  };

  if (refreshing) {
    const fetched = [];
    for (const account of config.stellar ?? []) {
      fetched.push(await refreshStellar(account, log));
      fetched.push(await refreshStellarEffects(account, log));
      fetched.push(await refreshStellarFees(account, log));
      fetched.push(await refreshBlendOps(account, log));
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
    if (!cache) throw new Error(`no cached history for ${account}, run without --cached`);
    flows.push(...stellarFlows(cache));
  }
  for (const owner of config.solana ?? []) {
    const cache = loadCache(`solana-${owner.slice(0, 8)}`, undefined);
    if (!cache) throw new Error(`no cached history for ${owner}, run without --cached`);
    flows.push(...solanaFlows(cache, mintSymbols));
  }

  // Money moving between the two wallets is not a contribution.
  const own = new Set([...(config.stellar ?? []), ...(config.solana ?? [])]);
  flows = flows.filter((f) => !own.has(f.other));
  const bridgeCandidates = [];
  for (const account of config.stellar ?? []) {
    const fx = loadStellarEffects(account, { refreshed: refreshing });
    for (const c of fx?.credits ?? []) {
      bridgeCandidates.push({ chain: 'stellar', at: c.at, dir: c.dir, asset: c.asset, amount: c.amount, viaEffect: true });
    }
  }
  const { pairs, internal } = matchCrossWallet([...flows, ...bridgeCandidates]);
  const external = flows.filter((f) => !internal.has(f));
  const roundTrips = sameChainRoundTrips(external);

  // Value each one on the day it happened.
  const worthlessIndex = args.indexOf('--worthless');
  const worthless = new Set(
    worthlessIndex >= 0 ? (args[worthlessIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [],
  );

  const noSource = [];
  const failedPricing = [];
  for (const f of external) {
    if (worthless.has(f.asset)) {
      // Declared worthless, so zero is the right price rather than a missing one.
      f.usd = 0;
      f.price = 0;
      continue;
    }
    const { usd, reason } = await priceOn(f.asset, f.at, f.issuer);
    if (usd === undefined) {
      f.usd = 0;
      // No source quotes it at all: treat zero as the price, which is what a junk token is
      // worth. A source that exists but failed is an error and must not be silently zeroed.
      (reason === 'failed' ? failedPricing : noSource).push(f);
    } else {
      f.usd = f.amount * usd;
      f.price = usd;
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
    : await currentValue(configPath);
  const now = value.total;
  const gain = now - net;

  // Per chain, a transfer between your own wallets is a real contribution to the receiving
  // side and a real withdrawal from the sending side. They cancel in the total, which is
  // what makes the two halves add back up to it.
  for (const pair of pairs) {
    const { usd } = await priceOn(pair.out.asset, pair.out.at, pair.out.issuer);
    pair.usd = (usd ?? 0) * pair.out.amount;
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
      deposits, withdrawals, crossWalletTransfers: pairs,
      pricedAtZero: noSource, failedPricing,
      depositedUsd: inUsd, withdrawnUsd: outUsd, netContributedUsd: net,
      currentUsd: now, gainUsd: gain,
      returnPct: inUsd > 0 ? ((outUsd + now - inUsd) / inUsd) * 100 : undefined,
      modifiedDietz: modifiedDietz(external, now),
      gainOnNetContributedPct: net > 0 ? (gain / net) * 100 : undefined,
      byChain: perChain,
    }, null, 2));
    return 0;
  }

  const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Always signed: a bare "4.20%" next to a negative dollar figure reads as a gain.
  const pct = (n) => (n === undefined ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

  if (showLots) {
    // A swap needs one USD value for the whole trade. A stablecoin leg gives it directly;
    // otherwise price the other side at the moment of the trade. Both sides then share it,
    // which is what keeps the two models reconcilable.
    const swaps = [];
    for (const owner of config.solana ?? []) {
      swaps.push(...solanaSwaps(loadCache(`solana-${owner.slice(0, 8)}`, { events: [] }), mintSymbols));
    }
    for (const account of config.stellar ?? []) {
      void account; // stellar swaps come from movements below
    }

    const swapIssues = [];
    const valuedSwaps = [];
    for (const s of swaps) {
      let usd;
      for (const leg of [...s.gave, ...s.got]) {
        if (STABLES.has(leg.asset)) { usd = leg.amount; break; }
      }
      if (usd === undefined) {
        for (const leg of [...s.gave, ...s.got]) {
          const { usd: p } = await priceOn(leg.asset, s.at);
          if (p !== undefined) { usd = p * leg.amount; break; }
        }
      }
      if (usd === undefined) {
        swapIssues.push(`${s.at.slice(0, 10)} swap on ${s.chain} could not be valued: ${s.gave.map((g) => g.asset).join('+')} for ${s.got.map((g) => g.asset).join('+')}`);
        continue;
      }
      valuedSwaps.push({ ...s, kind: 'swap', usd });
    }

    // Blend movements, decoded from the submit() requests rather than guessed from balances.
    const blendEntries = [];
    for (const account of config.stellar ?? []) {
      const ops = loadCache(`blend-ops-${account.slice(0, 8)}`, { ops: {} }).ops;
      for (const [hash, op] of Object.entries(ops)) {
        for (const r of op.requests) {
          const asset = SAC_SYMBOL[r.contract];
          if (!asset) {
            swapIssues.push(`blend ${r.kind} of an unrecognised reserve ${r.contract.slice(0, 8)} on ${op.at.slice(0, 10)}`);
            continue;
          }
          blendEntries.push({
            kind: `blend-${r.kind}`,
            chain: 'stellar',
            pool: `blend:${r.pool.slice(0, 8)}`,
            asset,
            amount: r.amount,
            at: op.at,
            tx: hash,
          });
        }
      }
    }
    // Borrow and repay need a USD value; supply and withdraw only move basis around.
    for (const e of blendEntries) {
      if (e.kind !== 'blend-borrow' && e.kind !== 'blend-repay') continue;
      const { usd: p } = await priceOn(e.asset, e.at);
      if (p === undefined) {
        swapIssues.push(`could not value a ${e.kind.slice(6)} of ${e.amount} ${e.asset} on ${e.at.slice(0, 10)}`);
        e.skip = true;
      } else {
        e.usd = p * e.amount;
      }
    }

    // Stellar entries come from wallet movements, not protocol decoding. Every operation is
    // one of three things: value crossing the wallet boundary to a third party, an exchange
    // of one asset for another, or a transfer to a contract you control. That third case is
    // what all the Blend decoding was for, and it does not need it: basis travels with the
    // asset, which is true of a supply, a withdrawal, a borrow, a repayment, a backstop
    // deposit and an emissions claim alike.
    // Which transactions were borrows or repayments. Everything else moving between the
    // wallet and a contract is a plain transfer, but a borrow is not: it creates a debt, and
    // treating it as a transfer hands you the asset for free and books its sale as profit.
    const borrowTx = new Map();
    for (const account of config.stellar ?? []) {
      const ops = loadCache(`blend-ops-${account.slice(0, 8)}`, { ops: {} }).ops;
      for (const [hash, op] of Object.entries(ops)) {
        for (const r of op.requests) {
          if (r.kind !== 'borrow' && r.kind !== 'repay') continue;
          const asset = SAC_SYMBOL[r.contract];
          if (asset) borrowTx.set(`${op.at}|${asset}`, r.kind);
        }
      }
    }

    // Movements already accounted for elsewhere. An external flow becomes an in/out entry
    // and a matched cross-wallet transfer becomes a bridge entry, so replaying the same
    // balance change as a contract transfer would credit the wallet twice.
    // Which side of the wallet a contract transfer lands on. Lumping every contract into
    // one "invested" bucket made a Blend supply and a backstop deposit indistinguishable,
    // and the two are worth very different things.
    const poolLocations = new Map(
      (config.blendPools ?? []).map((id) => [id, `blend:${id.slice(0, 8)}`]),
    );
    const locationOf = (contract) =>
      (contract && (value.lpTokens?.[contract] ?? poolLocations.get(contract))) ?? 'invested';

    const externalOps = new Set();
    for (const f of external.filter((f) => f.chain === 'stellar')) externalOps.add(`${f.at}|${f.asset}`);
    for (const p of pairs) {
      for (const leg of [p.out, p.in]) {
        if (leg.chain === 'stellar') externalOps.add(`${leg.at}|${leg.asset}`);
      }
    }
    const stellarEntries = [];
    for (const account of config.stellar ?? []) {
      const effects = loadStellarEffects(account, { refreshed: refreshing });
      for (const g of stellarMovements(effects)) {
        if (g.moves.some((m) => externalOps.has(`${g.at}|${m.asset}`))) continue; // counted as an external flow
        const ups = g.moves.filter((m) => m.amount > 0);
        const downs = g.moves.filter((m) => m.amount < 0);
        if (ups.length && downs.length) {
          stellarEntries.push({
            kind: 'swap', chain: 'stellar', at: g.at, tx: g.op,
            gave: downs.map((m) => ({ asset: m.asset, amount: -m.amount })),
            got: ups.map((m) => ({ asset: m.asset, amount: m.amount })),
          });
        } else {
          const where = locationOf(g.contract);
          for (const m of g.moves) {
            const tagged = borrowTx.get(`${g.at}|${m.asset}`);
            const kind = tagged === 'borrow' ? 'blend-borrow'
              : tagged === 'repay' ? 'blend-repay'
              : m.amount > 0 ? 'from-contract' : 'to-contract';
            stellarEntries.push({
              kind, chain: 'stellar', pool: where, at: g.at, viaContract: g.contract,
              asset: m.asset, amount: Math.abs(m.amount), tx: g.op,
            });
          }
        }
      }
    }
    for (const s of stellarEntries) {
      if (s.kind === 'blend-borrow' || s.kind === 'blend-repay') {
        const { usd: p } = await priceOn(s.asset, s.at);
        if (p === undefined) s.skip = true;
        else s.usd = p * s.amount;
        continue;
      }
      if (s.kind !== 'swap') continue;
      let v;
      for (const leg of [...s.gave, ...s.got]) if (STABLES.has(leg.asset)) { v = leg.amount; break; }
      if (v === undefined) {
        for (const leg of [...s.gave, ...s.got]) {
          const { usd: p } = await priceOn(leg.asset, s.at);
          if (p !== undefined) { v = p * leg.amount; break; }
        }
      }
      if (v === undefined) { s.skip = true; swapIssues.push(`${s.at.slice(0, 10)} stellar swap could not be valued`); }
      else s.usd = v;
    }

    // Everything the network itself took or gave back. Neither chain reports it as a
    // transfer, but both spend real balance on it, so leaving it out means the replay holds
    // units the wallet does not. On a wallet that opened a lot of token accounts the rent
    // alone came to a quarter of a SOL.
    const chainCosts = [];
    for (const owner of config.solana ?? []) {
      const cache = loadCache(`solana-${owner.slice(0, 8)}`, { events: [] });
      for (const e of cache.events) {
        // The same rule the flow and swap readers use, so this picks up exactly what they
        // left behind: the fee, plus any SOL move too small for them to have called real.
        const counted = Math.abs(e.sol + e.fee) > 0.03 ? e.sol + e.fee : 0;
        const delta = e.sol - counted;
        if (Math.abs(delta) < 1e-9) continue;
        chainCosts.push({
          kind: 'chain-cost', chain: 'solana', asset: 'SOL', delta,
          at: new Date(e.ts * 1000).toISOString(), tx: e.sig,
        });
      }
    }
    for (const account of config.stellar ?? []) {
      const fees = loadCache(`stellar-fees-${account.slice(0, 8)}`, undefined);
      if (!fees) {
        swapIssues.push(
          `no fee history cached for ${account.slice(0, 8)}, so XLM spent on fees is still ` +
          'counted as held. Run without --cached to fetch it',
        );
      }
      for (const f of fees?.charges ?? []) {
        chainCosts.push({
          kind: 'chain-cost', chain: 'stellar', asset: 'XLM', delta: -f.fee, at: f.at, tx: f.tx,
        });
      }
    }

    // Corrections you had to make by hand, because no endpoint reports them for this wallet.
    const adjustments = (config.adjustments ?? []).map((a) => ({
      kind: 'adjustment',
      chain: a.location ?? a.chain,
      asset: a.asset,
      amount: a.amount,
      usd: a.usd ?? 0,
      at: a.at,
      note: a.note,
    }));
    for (const a of adjustments) {
      if (!a.at || !a.asset || !a.chain || !Number.isFinite(a.amount) || a.amount === 0) {
        throw new Error(`bad adjustment in ${configPath}: needs at, location, asset and a non-zero amount`);
      }
    }

    const entries = [
      ...adjustments,
      ...chainCosts,
      ...stellarEntries.filter((e) => !e.skip),
      ...external.map((f) => ({ kind: f.dir, chain: f.chain, asset: f.asset, amount: f.amount, usd: f.usd, at: f.at })),
      ...pairs.map((p) => ({
        // Sent and received differ by whatever the bridge charged. Opening the received
        // amount on the far side is what makes the destination wallet add up.
        kind: 'bridge', at: p.out.at, asset: p.out.asset, amount: p.out.amount,
        received: p.in.amount, usd: p.usd, fromChain: p.out.chain, toChain: p.in.chain,
      })),
      ...valuedSwaps,
    ].sort((a, b) => a.at.localeCompare(b.at));

    const nowIso = new Date().toISOString();
    const currentPrices = { ...(value.prices ?? {}) };
    for (const asset of new Set(entries.flatMap((e) => e.asset ? [e.asset] : [...(e.gave ?? []), ...(e.got ?? [])].map((g) => g.asset)))) {
      if (currentPrices[asset] !== undefined) continue;
      const { usd: p } = await priceOn(asset, nowIso);
      if (p !== undefined) currentPrices[asset] = p;
    }

    const traceIndex = args.indexOf('--trace');
    if (traceIndex >= 0) {
      const want = args[traceIndex + 1];
      const [wLoc, wAsset] = [want.slice(0, want.lastIndexOf(':')), want.slice(want.lastIndexOf(':') + 1)];
      let bal = 0;
      for (const e of entries) {
        const legs = [];
        if (e.kind === 'swap') {
          for (const g of e.gave) if (e.chain === wLoc && g.asset === wAsset) legs.push(-g.amount);
          for (const g of e.got) if (e.chain === wLoc && g.asset === wAsset) legs.push(+g.amount);
        } else if (e.kind === 'bridge') {
          if (e.asset === wAsset && e.fromChain === wLoc) legs.push(-e.amount);
          if (e.asset === wAsset && e.toChain === wLoc) legs.push(+(e.received ?? e.amount));
        } else if (e.kind === 'to-contract') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(-e.amount);
          if (e.asset === wAsset && (e.pool ?? 'invested') === wLoc) legs.push(+e.amount);
        } else if (e.kind === 'from-contract') {
          if (e.asset === wAsset && (e.pool ?? 'invested') === wLoc) legs.push(-e.amount);
          if (e.asset === wAsset && e.chain === wLoc) legs.push(+e.amount);
        } else if (e.kind === 'blend-borrow') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(+e.amount);
        } else if (e.kind === 'blend-repay') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(-e.amount);
        } else if (e.kind === 'chain-cost') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(e.delta);
        } else if (e.kind === 'adjustment') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(e.amount);
        } else if (e.kind === 'in') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(+e.amount);
        } else if (e.kind === 'out') {
          if (e.asset === wAsset && e.chain === wLoc) legs.push(-e.amount);
        }
        if (!legs.length) continue;
        const delta = legs.reduce((a, b) => a + b, 0);
        bal += delta;
        console.log(`  ${e.at}  ${String(e.kind).padEnd(14)} ${delta >= 0 ? '+' : ''}${delta.toFixed(7).padStart(15)}  -> ${bal.toFixed(7).padStart(15)}  ${e.tx ?? ''}`);
      }
      console.log(`  final ${wLoc}:${wAsset} = ${bal.toFixed(7)}`);
      return 0;
    }
    // The backstop is the one place value goes and stops being what it was: USDC and BLND
    // are swapped for a comet LP share whose price moves on its own, and the share never
    // touches the wallet, so no effect records it.
    const opaqueLocations = Object.fromEntries(
      Object.entries(value.locations ?? {}).filter(([k]) => k.startsWith('backstop:')),
    );
    const result = runLots({ entries, currentPrices, marketValue: value.total, opaqueLocations });

    const drift0 = result.realised + result.unrealised - gain;
    const reconciles = Math.abs(drift0) < 0.01;
    console.log('');
    console.log('FIFO cost basis');
    console.log(`  realised          ${usd(result.realised).padStart(14)}   from ${result.disposals.length} disposals`);
    console.log(`  unrealised        ${usd(result.unrealised).padStart(14)}   on what is still held`);
    console.log(`  total             ${usd(result.realised + result.unrealised).padStart(14)}`);
    console.log('');
    // The whole engine either agrees with the aggregate figure or it is wrong.
    console.log(`  aggregate gain    ${usd(gain).padStart(14)}   (taken out + worth today - put in)`);
    console.log(`  difference        ${usd(drift0).padStart(14)}   ${reconciles ? 'reconciles' : 'DOES NOT RECONCILE'}`);
    if (!reconciles) {
      console.log('');
      console.log('  These two are the same number by construction, so a difference here is');
      console.log('  arithmetic drift in the replay itself, not missing history. Something is');
      console.log('  creating or destroying basis outside open() and close().');
    }

    // The check that used to live above. Splitting it out is the point: the replay tracks
    // basis, the portfolio tracks quantities, and only the second can be wrong without the
    // first noticing. A gap here means the replay's idea of what you hold has drifted from
    // the chain, which is the failure mode worth surfacing.
    const positionDrift = result.markedValue - value.total;
    console.log('');
    console.log('  position check   the replay marks its own holdings against the portfolio');
    console.log(`    replay marks    ${usd(result.markedValue).padStart(14)}`);
    console.log(`    portfolio says  ${usd(value.total).padStart(14)}`);
    console.log(`    drift           ${usd(positionDrift).padStart(14)}   ${Math.abs(positionDrift) < Math.max(1, value.total * 0.005) ? 'positions agree' : 'positions differ, see below'}`);

    // A total on its own says nothing about whether the replay is sound. Broken out per
    // holding it is obvious: pool interest and unclaimed emissions are value that accrued
    // without a transaction to see, and they should be small and positive. Anything large,
    // or negative on an asset that only accrues, is a gap in the history.
    const replayAmounts = new Map();
    for (const h of result.holdings) {
      if (h.opaque) continue;
      replayAmounts.set(`${h.chain}|${h.asset}`, (replayAmounts.get(`${h.chain}|${h.asset}`) ?? 0) + h.amount);
    }
    for (const d of result.outstanding ?? []) {
      replayAmounts.set(`${d.location}|${d.asset}`, (replayAmounts.get(`${d.location}|${d.asset}`) ?? 0) - d.amount);
    }
    const rows = [];
    const seenKeys = new Set();
    for (const [location, assets] of Object.entries(value.positions ?? {})) {
      if (opaqueLocations[location] !== undefined) continue;
      for (const [asset, actual] of Object.entries(assets)) {
        const k = `${location}|${asset}`;
        seenKeys.add(k);
        const modelled = replayAmounts.get(k) ?? 0;
        const price = currentPrices[asset];
        // Signed the same way as the drift above, so the rows add up to it: positive means
        // the replay thinks you hold more than the chain does.
        const delta = modelled - actual.amount;
        if (Math.abs(delta) < 1e-6) continue;
        rows.push({ location, asset, modelled, actual: actual.amount, usd: price === undefined ? undefined : delta * price });
      }
    }
    for (const [k, modelled] of replayAmounts) {
      if (seenKeys.has(k) || Math.abs(modelled) < 1e-6) continue;
      const [location, asset] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const price = currentPrices[asset];
      rows.push({ location, asset, modelled, actual: 0, usd: price === undefined ? undefined : modelled * price });
    }
    for (const r of rows.sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0))) {
      if (Math.abs(r.usd ?? 0) < 0.01) continue;
      const qty = `replay ${r.modelled.toLocaleString('en-US', { maximumFractionDigits: 4 })}` +
        ` vs chain ${r.actual.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
      console.log(`      ${r.location.padEnd(18)} ${r.asset.padEnd(9)} ${usd(r.usd ?? 0).padStart(10)}   ${qty}`);
    }
    // Value sitting in "invested" means a contract nobody named. The portfolio has no
    // reason to look at it, so the drift above is a missing line in wallets.json rather
    // than anything wrong with the history, and saying which contract makes that fixable.
    if (result.holdings.some((h) => h.chain === 'invested')) {
      // Only contracts still holding something. An emitter you claimed from is a contract
      // you sent nothing to, and listing it as a pool to configure would be wrong.
      const net = new Map();
      for (const e of stellarEntries) {
        if (e.pool !== 'invested' || !e.viaContract) continue;
        const sign = e.kind === 'to-contract' ? 1 : -1;
        net.set(e.viaContract, (net.get(e.viaContract) ?? 0) + sign * e.amount);
      }
      const unknown = new Set([...net].filter(([, n]) => n > DUST).map(([c]) => c));
      if (unknown.size) {
        console.log('');
        console.log('    value is held by contracts that are not in the config, so the portfolio');
        console.log('    never looks at them. Add the pools to blendPools:');
        for (const c of unknown) console.log(`      ${c}`);
      }
    }
    if (adjustments.length) {
      console.log('');
      console.log('    adjustments applied by hand, from the config:');
      for (const a of adjustments) {
        console.log(
          `      ${a.at.slice(0, 10)}  ${a.chain} ${a.asset} ` +
          `${a.amount > 0 ? '+' : ''}${a.amount}${a.note ? `  ${a.note}` : ''}`,
        );
      }
    }

    if (result.holdings.length) {
      console.log('');
      console.log('  positions the lot engine thinks you hold');
      for (const h of [...result.holdings].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))) {
        const mark = h.opaque ? 'in an LP share' : h.value === undefined ? 'unpriced' : usd(h.value);
        console.log(
          `    ${h.chain.padEnd(16)} ${h.asset.padEnd(8)} ${h.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(14)}` +
          `  basis ${usd(h.basis).padStart(11)}  value ${mark.padStart(13)}`,
        );
      }
      // The locations whose contents were swapped for something the wallet never sees. One
      // line each, because their constituents cannot be marked but the position can.
      for (const m of result.locationMarks ?? []) {
        console.log(
          `    ${m.location.padEnd(16)} ${'LP share'.padEnd(8)} ${''.padStart(14)}` +
          `  basis ${usd(m.basis).padStart(11)}  value ${usd(m.value).padStart(13)}`,
        );
      }
      for (const d of result.outstanding ?? []) {
        console.log(`    ${d.location.padEnd(16)} ${d.asset.padEnd(8)} ${(-d.amount).toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(14)}  owed`);
      }
    }

    if (result.disposals.length) {
      console.log('');
      console.log('  largest disposals');
      for (const d of [...result.disposals].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, 10)) {
        console.log(
          `    ${d.at.slice(0, 10)}  ${d.asset.padEnd(8)} ${d.label.padEnd(10)} ` +
          `proceeds ${usd(d.proceeds).padStart(11)}  basis ${usd(d.basis).padStart(11)}  ${usd(d.gain).padStart(11)}`,
        );
      }
    }
    for (const i of [...swapIssues, ...result.issues].slice(0, 12)) console.log(`  note: ${i}`);
    console.log('');
  }


  if (args.includes('--activity')) {
    console.log('Activity (every transaction, and how it was read)');
    for (const owner of config.solana ?? []) {
      const cache = loadCache(`solana-${owner.slice(0, 8)}`, { events: [] });
      const rows = solanaActivity(cache, mintSymbols);
      const tally = {};
      for (const r of rows) {
        tally[r.kind] = (tally[r.kind] ?? 0) + 1;
        const desc = r.moves.length
          ? r.moves.map((m) => `${m.asset} ${m.amount > 0 ? '+' : ''}${m.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}`).join('  ')
          : '(nothing material)';
        const label = r.kind === 'swap' ? 'swap, internal' : r.kind;
        console.log(`  ${r.at.slice(0, 16)}  ${label.padEnd(15)} ${desc}`);
      }
      console.log('');
      for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(4)}  ${k}`);
      }
      console.log('');
    }
  }

  if (roundTrips.length) {
    console.log('');
    console.log(`Same asset out and back on one chain (${roundTrips.length}), counted as a withdrawal plus a deposit:`);
    for (const p of roundTrips) {
      const days = Math.round((Date.parse(p.in.at) - Date.parse(p.out.at)) / 86400000);
      console.log(
        `  ${p.out.asset.padEnd(8)} out ${p.out.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(13)} on ${p.out.at.slice(0, 10)}` +
        `  ->  in ${p.in.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(13)} on ${p.in.at.slice(0, 10)}  (${days}d)`,
      );
    }
    console.log('  These inflate put in and taken out by the same amount, so the gain is unaffected');
    console.log('  but the percentages are diluted. Likely an issuance rollover, not real flows.');
  }

  if (args.includes('--flows')) {
    // Internal transfers are listed alongside the external ones, because leaving them out
    // of the list while counting them in the per-chain totals makes those totals look wrong.
    const listed = [
      ...external.map((f) => ({ ...f, tag: '' })),
      ...pairs.flatMap((p) => [
        { ...p.out, usd: p.usd, tag: `internal, to ${p.in.chain}` },
        { ...p.in, usd: p.usd, tag: `internal, from ${p.out.chain}` },
      ]),
    ].sort((a, b) => a.at.localeCompare(b.at));

    console.log('Flows');
    for (const f of listed) {
      console.log(
        `  ${f.at.slice(0, 10)}  ${f.dir === 'in' ? 'IN ' : 'OUT'}  ` +
        `${f.amount.toLocaleString('en-US', { maximumFractionDigits: 6 }).padStart(14)} ${f.asset.padEnd(8)} ` +
        `${usd(f.usd).padStart(12)}  ${f.chain.padEnd(8)}${f.tag}`,
      );
    }
    console.log('');
    console.log(`  external only:  in ${usd(inUsd)}, out ${usd(outUsd)}`);
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
  console.log(`${gain < 0 ? 'loss' : 'gain'}               ${usd(gain).padStart(14)}   ${pct(returnPct)} of everything put in`);

  const dietz = modifiedDietz(external, now);
  if (dietz?.periodReturn !== undefined) {
    const years = dietz.totalDays / 365;
    console.log(
      `time weighted      ${pct(dietz.periodReturn * 100).padStart(14)} over ${years.toFixed(1)}y` +
      `${dietz.annualised === undefined ? '' : `, ${pct(dietz.annualised * 100)} a year`}`,
    );
    console.log(`average capital    ${usd(dietz.averageCapital).padStart(14)}   what was actually at work, weighted by how long`);
  } else if (dietz?.undefinedReason) {
    console.log(`time weighted             undefined   ${dietz.undefinedReason}`);
  }
  // Not "at risk": the whole balance is exposed, gains included. This is how much of your
  // own money has not come back out, which is the cost basis for what is still there.
  console.log(`your money still in${usd(net).padStart(13)}   put in, less what you took back out`);

  if (value.byChain) {
    console.log('');
    console.log(
      '  by chain'.padEnd(17) + 'put in'.padStart(13) + 'taken out'.padStart(13) +
      'worth today'.padStart(14) + 'gain/loss'.padStart(13) + '   return    per year',
    );
    for (const [chain, c] of Object.entries(perChain)) {
      // Money bridged away left this chain as surely as a withdrawal did, so it belongs in
      // the cashflows. Leaving it out makes the sending chain look like it lost the money.
      const chainFlows = [
        ...external.filter((f) => f.chain === chain),
        ...pairs.filter((p) => p.out.chain === chain).map((p) => ({ at: p.out.at, dir: 'out', usd: p.usd })),
        ...pairs.filter((p) => p.in.chain === chain).map((p) => ({ at: p.in.at, dir: 'in', usd: p.usd })),
      ];
      const chainDietz = modifiedDietz(chainFlows, c.currentUsd);
      if (chainDietz?.annualised !== undefined) c.annualisedPct = chainDietz.annualised * 100;
      const suspect = failedPricing.filter((f) => f.chain === chain);
      const notes = [];
      if (c.bridgedInUsd) notes.push(`incl ${usd(c.bridgedInUsd)} bridged in`);
      if (c.bridgedOutUsd) notes.push(`incl ${usd(c.bridgedOutUsd)} bridged out`);
      if (suspect.length) notes.push(`${suspect.length} failed pricing, see below`);
      const flag = notes.length ? `  <- ${notes.join(', ')}` : '';
      console.log(
        `  ${chain.padEnd(15)}${usd(c.putInUsd).padStart(13)}${usd(c.tookOutUsd).padStart(13)}` +
        `${usd(c.currentUsd).padStart(14)}${usd(c.gainUsd).padStart(13)}   ${pct(c.returnPct).padStart(8)}` +
        `  ${(c.annualisedPct === undefined ? '' : pct(c.annualisedPct)).padStart(8)}${flag}`,
      );
    }
    const bridged = pairs.reduce((s, p) => s + p.usd, 0);
    if (bridged) {
      console.log('');
      console.log(`  ${usd(bridged)} bridged solana to stellar counts as taken out of one leg and put`);
      console.log('  into the other, so a chain is judged on what it returned, not what it still holds.');
    }
  }

  // No source quotes these, which is what a worthless token looks like. Zero is the price,
  // so this is a note rather than a warning: one line naming the assets, not the flows.
  if (noSource.length) {
    const assets = [...new Set(noSource.map((f) => f.asset))];
    console.log('');
    console.log(`priced at $0, no source quotes them: ${assets.join(', ')}` +
      `  (${noSource.length} flow${noSource.length > 1 ? 's' : ''})`);
  }

  // A source that exists and did not answer is a different thing entirely. Zeroing it
  // silently is how a rate limit turns into fabricated profit, so this one shouts.
  if (failedPricing.length) {
    const inCount = failedPricing.filter((f) => f.dir === 'in').length;
    const outCount = failedPricing.length - inCount;
    console.log('');
    console.log('  *** the gain above is not reliable ***');
    console.log(`  ${failedPricing.length} flow(s) have a price source that did not answer, so they were`);
    console.log('  counted as $0. This is a lookup failure, not a worthless asset:');
    for (const f of failedPricing) {
      console.log(`    ${f.at.slice(0, 10)}  ${f.dir === 'in' ? 'IN ' : 'OUT'}  ${f.amount} ${f.asset} (${f.chain})`);
    }
    if (inCount) console.log(`  ${inCount} of them are inflows, which OVERSTATES the gain.`);
    if (outCount) console.log(`  ${outCount} are outflows, which pushes it DOWN.`);
    console.log('  Re-run once the source is answering before trusting the percentage.');
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
