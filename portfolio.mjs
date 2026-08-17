#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Backstop,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV1,
  BackstopPoolV2,
  PoolContractV1,
  PoolContractV2,
  PoolMetadata,
  PoolV1,
  PoolV2,
  TokenMetadata,
} from '@blend-capital/blend-sdk';
import { BASE_FEE, Keypair, Networks, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const STELLAR_RPC = process.env.STELLAR_RPC_URL ?? 'https://mainnet.sorobanrpc.com';
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const SPL_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];
const WSOL = 'So11111111111111111111111111111111111111112';
const MIN_DEX_LIQUIDITY_USD = Number(process.env.MIN_DEX_LIQUIDITY_USD ?? 1000);
const USDC_CLASSIC = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' };

const warnings = [];
const warn = (msg) => warnings.push(msg);

/* ---------------------------------------------------------------- args + config */

function parseArgs(argv) {
  const opts = { stellar: [], solana: [], pools: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--stellar': opts.stellar.push(take()); break;
      case '--solana': opts.solana.push(take()); break;
      case '--blend-pool': opts.pools.push(take()); break;
      case '--config': opts.config = take(); break;
      case '--min-value': {
        opts.minValue = Number(take());
        if (!Number.isFinite(opts.minValue) || opts.minValue < 0) throw new Error('--min-value must be a non-negative number');
        break;
      }
      case '--json': case '--all': case '--gulp-emissions': case '--submit': case '--no-color':
        opts.flags.add(arg.slice(2));
        break;
      case '-h': case '--help': opts.flags.add('help'); break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function loadConfig(opts) {
  const path = opts.config
    ? resolve(opts.config)
    : (process.env.PORTFOLIO_CONFIG ? resolve(process.env.PORTFOLIO_CONFIG) : join(HERE, 'wallets.json'));

  let file = { stellar: [], solana: [], blendPools: [] };
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    try {
      if (raw) file = JSON.parse(raw);
    } catch (e) {
      throw new Error(`could not parse config ${path}: ${e.message}`);
    }
  } else if (opts.config) {
    throw new Error(`config not found: ${path}`);
  }

  const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  return {
    stellar: [...new Set([...asList(file.stellar), ...opts.stellar])],
    solana: [...new Set([...asList(file.solana), ...opts.solana])],
    blendPools: [...new Set([...asList(file.blendPools), ...opts.pools])],
  };
}

const USAGE = `
portfolio - total USD value of Stellar + Solana holdings

usage: node portfolio.mjs [options]

  --stellar <G...>       Stellar account (repeatable)
  --solana <addr>        Solana account (repeatable)
  --blend-pool <C...>    Blend pool contract to check for positions + backstop (repeatable)
  --config <path>        wallet config JSON (default: ./wallets.json)
  --min-value <usd>      collapse positions worth less than this (default 0.01)
  --all                  show every position, including zero balances and dust
  --json                 emit JSON instead of a table
  --no-color             plain output
  --gulp-emissions       simulate pool.gulp_emissions() for each Blend pool (read-only)
  --submit               with --gulp-emissions, sign and broadcast; needs a signing key
  -h, --help             this text

env: HORIZON_URL, STELLAR_RPC_URL, SOLANA_RPC_URL, PORTFOLIO_CONFIG,
     STELLAR_SECRET_KEY or STELLAR_SECRET_KEY_FILE (path to a file holding it)
`.trim();

/* ---------------------------------------------------------------- http */

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(lastError?.retryAfter ?? 400 * 2 ** (attempt - 1));

    let res;
    try {
      res = await fetch(url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
    } catch (e) {
      lastError = e;
      continue;
    }

    if (res.ok) return res.json();

    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    if (!RETRY_STATUS.has(res.status)) throw err;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = Math.min(retryAfter, 10) * 1000;
    lastError = err;
  }
  throw lastError;
}

const rpcCall = (url, method, params) =>
  getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((body) => {
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  });

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------------------------------------------------------------- price book */

const stellarKey = (code, issuer) => (issuer ? `stellar:${code}-${issuer}` : 'stellar:XLM');
const solanaKey = (mint) => `solana:${mint}`;

class PriceBook {
  constructor() {
    this.entries = new Map();
  }

  set(key, usd, source) {
    if (this.entries.has(key) || !Number.isFinite(usd)) return;
    this.entries.set(key, { usd, source });
  }

  get(key) {
    return this.entries.get(key);
  }

  has(key) {
    return this.entries.has(key);
  }
}

async function priceFromStellarExpert(book, assets) {
  await Promise.all(assets.map(async ({ code, issuer }) => {
    const key = stellarKey(code, issuer);
    if (book.has(key)) return;
    const id = issuer ? `${code}-${issuer}` : 'XLM';
    try {
      const body = await getJson(`https://api.stellar.expert/explorer/public/asset/${id}`);
      if (typeof body.price === 'number') book.set(key, body.price, 'stellar.expert');
    } catch (e) {
      warn(`stellar.expert price failed for ${code}: ${e.message}`);
    }
  }));
}

// Marginal DEX/AMM price: quote a single unit so the answer is not distorted by
// the slippage a full-position quote would include.
async function priceFromHorizonPaths(book, assets) {
  for (const { code, issuer } of assets) {
    const key = stellarKey(code, issuer);
    if (book.has(key)) continue;
    if (code === USDC_CLASSIC.code && issuer === USDC_CLASSIC.issuer) {
      book.set(key, 1, 'usdc-par');
      continue;
    }
    const source = issuer
      ? `source_asset_type=credit_alphanum${code.length > 4 ? 12 : 4}&source_asset_code=${code}&source_asset_issuer=${issuer}`
      : 'source_asset_type=native';
    for (const probe of [1, 100, 10000]) {
      try {
        const body = await getJson(
          `${HORIZON}/paths/strict-send?${source}&source_amount=${probe}` +
          `&destination_assets=${USDC_CLASSIC.code}:${USDC_CLASSIC.issuer}`,
        );
        const best = (body._embedded?.records ?? [])
          .map((r) => Number(r.destination_amount))
          .filter((n) => n > 0)
          .sort((a, b) => b - a)[0];
        if (best) {
          book.set(key, best / probe, `horizon-path(${probe})`);
          break;
        }
      } catch (e) {
        warn(`horizon path price failed for ${code}: ${e.message}`);
        break;
      }
    }
  }
}

async function priceSolana(book, mints) {
  const meta = new Map();
  for (const group of chunk(mints, 20)) {
    try {
      const found = await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${group.join(',')}`);
      for (const t of found ?? []) {
        meta.set(t.id, { symbol: t.symbol, name: t.name, decimals: t.decimals });
        if (typeof t.usdPrice === 'number') book.set(solanaKey(t.id), t.usdPrice, 'jupiter');
      }
    } catch (e) {
      warn(`jupiter lookup failed: ${e.message}`);
    }
  }

  const missing = mints.filter((m) => !book.has(solanaKey(m)));
  for (const group of chunk(missing, 30)) {
    try {
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${group.join(',')}`);
      const deepest = new Map();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p.baseToken?.address;
        const price = Number(p.priceUsd);
        const liq = Number(p.liquidity?.usd ?? 0);
        if (!mint || !Number.isFinite(price)) continue;
        // Jupiter already covers anything reputable; a thin pair here is usually
        // a spoofed mint, so ignore pools too shallow to mean anything.
        if (liq < MIN_DEX_LIQUIDITY_USD) continue;
        if (!deepest.has(mint) || deepest.get(mint).liq < liq) deepest.set(mint, { price, liq });
        if (!meta.has(mint) && p.baseToken?.symbol) {
          meta.set(mint, { symbol: p.baseToken.symbol, name: p.baseToken.name });
        }
      }
      for (const [mint, { price }] of deepest) book.set(solanaKey(mint), price, 'dexscreener');
    } catch (e) {
      warn(`dexscreener lookup failed: ${e.message}`);
    }
  }
  return meta;
}

/* ---------------------------------------------------------------- stellar wallet */

async function readStellarAccount(address) {
  const [account, claimable] = await Promise.all([
    getJson(`${HORIZON}/accounts/${address}`),
    getJson(`${HORIZON}/claimable_balances?claimant=${address}&limit=200`).catch((e) => {
      warn(`claimable balances failed for ${address}: ${e.message}`);
      return { _embedded: { records: [] } };
    }),
  ]);

  const holdings = [];
  const lpShares = [];
  for (const b of account.balances) {
    if (b.asset_type === 'liquidity_pool_shares') {
      lpShares.push({ poolId: b.liquidity_pool_id, shares: Number(b.balance) });
    } else if (b.asset_type === 'native') {
      holdings.push({ code: 'XLM', issuer: undefined, amount: Number(b.balance) });
    } else {
      holdings.push({ code: b.asset_code, issuer: b.asset_issuer, amount: Number(b.balance) });
    }
  }

  const pools = await Promise.all(lpShares.map(async ({ poolId, shares }) => {
    try {
      const pool = await getJson(`${HORIZON}/liquidity_pools/${poolId}`);
      const fraction = shares / Number(pool.total_shares);
      return {
        poolId,
        shares,
        reserves: pool.reserves.map((r) => {
          const [code, issuer] = r.asset === 'native' ? ['XLM', undefined] : r.asset.split(':');
          return { code, issuer, amount: Number(r.amount) * fraction };
        }),
      };
    } catch (e) {
      warn(`liquidity pool ${poolId} failed: ${e.message}`);
      return { poolId, shares, reserves: [] };
    }
  }));

  const claimables = (claimable._embedded?.records ?? []).map((r) => {
    const [code, issuer] = r.asset === 'native' ? ['XLM', undefined] : r.asset.split(':');
    return { code, issuer, amount: Number(r.amount), id: r.id };
  });

  return { address, holdings, pools, claimables };
}

/* ---------------------------------------------------------------- blend */

const NETWORK = { rpc: STELLAR_RPC, passphrase: Networks.PUBLIC };

async function loadPool(poolId) {
  const metadata = await PoolMetadata.load(NETWORK, poolId);
  try {
    return { pool: await PoolV2.loadWithMetadata(NETWORK, poolId, metadata), version: 'V2' };
  } catch (e) {
    return { pool: await PoolV1.loadWithMetadata(NETWORK, poolId, metadata), version: 'V1' };
  }
}

async function readBlendPool(poolId, users) {
  const { pool, version } = await loadPool(poolId);
  const [oracle, backstop, tokens] = await Promise.all([
    pool.loadOracle(),
    Backstop.load(NETWORK, pool.metadata.backstop),
    Promise.all([...pool.reserves.keys()].map(async (assetId) => [assetId, await TokenMetadata.load(NETWORK, assetId)])),
  ]);
  const tokenMeta = new Map(tokens);
  const blndMeta = await TokenMetadata.load(NETWORK, backstop.config.blndTkn);

  const backstopPool = await (version === 'V2' ? BackstopPoolV2 : BackstopPoolV1).load(
    NETWORK, pool.metadata.backstop, poolId,
  );

  const positions = await Promise.all(users.map(async (address) => {
    const [poolUser, backstopUser] = await Promise.all([
      pool.loadUser(address),
      BackstopPoolUser.load(NETWORK, pool.metadata.backstop, poolId, address),
    ]);

    const legs = [];
    for (const [assetId, reserve] of pool.reserves) {
      const supply = poolUser.getSupplyFloat(reserve);
      const collateral = poolUser.getCollateralFloat(reserve);
      const borrowed = poolUser.getLiabilitiesFloat(reserve);
      if (!supply && !collateral && !borrowed) continue;
      legs.push({ assetId, meta: tokenMeta.get(assetId), supply, collateral, borrowed });
    }

    const bs = BackstopPoolUserEst.build(backstop, backstopPool, backstopUser);
    const queuedTokens = backstopPool.sharesToBackstopTokensFloat(backstopUser.balance.totalQ4W);

    return {
      address,
      legs,
      emissions: poolUser.estimateEmissions([...pool.reserves.values()]).emissions,
      backstop: {
        deposited: bs.tokens,
        queued: queuedTokens,
        unlocked: bs.totalUnlockedQ4W,
        lpTokenPrice: backstop.backstopToken.lpTokenPrice,
        blndPerLpToken: backstop.backstopToken.blndPerLpToken,
        usdcPerLpToken: backstop.backstopToken.usdcPerLpToken,
        emissions: bs.emissions,
      },
    };
  }));

  return { poolId, version, name: pool.metadata.name, pool, oracle, tokenMeta, blndMeta, positions };
}

/* ---------------------------------------------------------------- solana wallet */

async function readSolanaAccount(address) {
  const [lamports, ...tokenSets] = await Promise.all([
    rpcCall(SOLANA_RPC, 'getBalance', [address]),
    ...SPL_PROGRAMS.map((programId) =>
      rpcCall(SOLANA_RPC, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }])),
  ]);

  const byMint = new Map();
  for (const set of tokenSets) {
    for (const acct of set.value ?? []) {
      const info = acct.account.data.parsed.info;
      const amount = Number(info.tokenAmount.uiAmountString);
      const prev = byMint.get(info.mint) ?? { mint: info.mint, amount: 0, decimals: info.tokenAmount.decimals };
      prev.amount += amount;
      byMint.set(info.mint, prev);
    }
  }

  return {
    address,
    sol: lamports.value / 1e9,
    tokens: [...byMint.values()],
  };
}

/* ---------------------------------------------------------------- gulp emissions */

async function gulpEmissions(poolId, version, sourceAddress, submit) {
  const server = new rpc.Server(STELLAR_RPC);
  const contract = new (version === 'V2' ? PoolContractV2 : PoolContractV1)(poolId);
  const parser = (version === 'V2' ? PoolContractV2 : PoolContractV1).parsers.gulpEmissions;

  const keypair = submit ? Keypair.fromSecret(requireSecret()) : undefined;
  const source = keypair ? keypair.publicKey() : sourceAddress;
  if (!source) throw new Error('no source account: pass --stellar or set STELLAR_SECRET_KEY');

  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(xdr.Operation.fromXDR(contract.gulpEmissions(), 'base64'))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { poolId, submitted: false, error: sim.error };

  const gulped = sim.result?.retval ? Number(parser(sim.result.retval.toXDR('base64'))) / 1e7 : 0;
  const prepared = rpc.assembleTransaction(tx, sim).build();
  const result = {
    poolId,
    source,
    gulpedBlnd: gulped,
    feeStroops: Number(prepared.fee),
    submitted: false,
  };
  if (!submit) return result;

  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') return { ...result, error: JSON.stringify(sent.errorResult ?? sent) };

  result.hash = sent.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'NOT_FOUND') continue;
    result.submitted = got.status === 'SUCCESS';
    result.status = got.status;
    if (got.status !== 'SUCCESS') result.error = JSON.stringify(got.resultXdr ?? got);
    return result;
  }
  return { ...result, status: 'TIMEOUT', error: 'transaction not confirmed in 60s' };
}

function requireSecret() {
  if (process.env.STELLAR_SECRET_KEY) return process.env.STELLAR_SECRET_KEY.trim();

  const path = process.env.STELLAR_SECRET_KEY_FILE;
  if (path) {
    if (!existsSync(path)) throw new Error(`STELLAR_SECRET_KEY_FILE not found: ${path}`);
    const secret = readFileSync(path, 'utf8').trim();
    if (!secret) throw new Error(`STELLAR_SECRET_KEY_FILE is empty: ${path}`);
    return secret;
  }
  throw new Error('--submit needs STELLAR_SECRET_KEY or STELLAR_SECRET_KEY_FILE in the environment');
}

/* ---------------------------------------------------------------- valuation */

function buildReport(config, stellarAccounts, blendPools, solanaAccounts, book, solanaMeta) {
  const sections = [];
  const unpriced = [];
  const priceOf = (key) => book.get(key);

  const value = (key, amount, label) => {
    const p = priceOf(key);
    if (!p) {
      if (amount > 0) unpriced.push({ label, amount });
      return { usd: 0, price: undefined, source: 'unpriced' };
    }
    return { usd: amount * p.usd, price: p.usd, source: p.source };
  };

  for (const account of stellarAccounts) {
    const rows = [];
    for (const h of account.holdings) {
      const v = value(stellarKey(h.code, h.issuer), h.amount, `${h.code} (Stellar)`);
      rows.push({ label: h.code, amount: h.amount, ...v });
    }
    for (const pool of account.pools) {
      const usd = pool.reserves.reduce(
        (sum, r) => sum + value(stellarKey(r.code, r.issuer), r.amount, `${r.code} (Stellar LP)`).usd, 0);
      rows.push({
        label: `LP ${pool.reserves.map((r) => r.code).join('/')}`,
        amount: pool.shares,
        usd,
        source: 'horizon-lp',
      });
    }
    for (const c of account.claimables) {
      const v = value(stellarKey(c.code, c.issuer), c.amount, `${c.code} (claimable)`);
      rows.push({ label: `${c.code} (claimable)`, amount: c.amount, ...v });
    }
    sections.push({ title: `Stellar wallet ${account.address}`, rows });
  }

  for (const blend of blendPools) {
    for (const position of blend.positions) {
      const rows = [];
      for (const leg of position.legs) {
        const symbol = leg.meta?.symbol ?? leg.assetId.slice(0, 8);
        const net = leg.supply + leg.collateral - leg.borrowed;
        const key = blendPriceKey(leg, blend, book);
        const v = value(key, Math.abs(net), `${symbol} (Blend ${blend.name})`);
        rows.push({
          label: leg.borrowed ? `${symbol} (net of ${fmtQty(leg.borrowed)} borrowed)` : symbol,
          amount: net,
          price: v.price,
          source: v.source,
          usd: net < 0 ? -v.usd : v.usd,
        });
      }
      if (position.emissions > 0) {
        const key = stellarKey(blend.blndMeta.symbol, blend.blndMeta.asset?.getIssuer());
        const v = value(key, position.emissions, 'BLND (pool emissions)');
        rows.push({ label: 'BLND emissions (unclaimed)', amount: position.emissions, ...v });
      }
      sections.push({ title: `Blend ${blend.version} pool "${blend.name}" supplied - ${blend.poolId}`, rows });

      const bs = position.backstop;
      const bsRows = [];
      if (bs.deposited > 0) {
        bsRows.push({
          label: 'BLND-USDC LP (deposited)',
          amount: bs.deposited,
          price: bs.lpTokenPrice,
          source: 'blend-comet',
          usd: bs.deposited * bs.lpTokenPrice,
        });
      }
      if (bs.queued > 0) {
        bsRows.push({
          label: `BLND-USDC LP (queued${bs.unlocked > 0 ? `, ${fmtQty(bs.unlocked)} unlocked` : ''})`,
          amount: bs.queued,
          price: bs.lpTokenPrice,
          source: 'blend-comet',
          usd: bs.queued * bs.lpTokenPrice,
        });
      }
      if (bs.emissions > 0) {
        const key = stellarKey(blend.blndMeta.symbol, blend.blndMeta.asset?.getIssuer());
        const v = value(key, bs.emissions, 'BLND (backstop emissions)');
        bsRows.push({ label: 'BLND emissions (unclaimed)', amount: bs.emissions, ...v });
      }
      if (bsRows.length) {
        sections.push({ title: `Blend backstop "${blend.name}" - ${blend.poolId}`, rows: bsRows });
      }
    }
  }

  for (const account of solanaAccounts) {
    const rows = [];
    const solValue = value(solanaKey(WSOL), account.sol, 'SOL');
    rows.push({ label: 'SOL', amount: account.sol, ...solValue });
    for (const t of account.tokens) {
      const meta = solanaMeta.get(t.mint);
      const v = value(solanaKey(t.mint), t.amount, `${meta?.symbol ?? t.mint} (Solana)`);
      rows.push({ label: meta?.symbol ?? `${t.mint.slice(0, 6)}...${t.mint.slice(-4)}`, amount: t.amount, mint: t.mint, ...v });
    }
    sections.push({ title: `Solana wallet ${account.address}`, rows });
  }

  return { sections, unpriced };
}

// Prefer the pool's own on-chain oracle for reserve assets; fall back to the
// classic-asset price if the token is a Stellar Asset Contract.
function blendPriceKey(leg, blend, book) {
  const oraclePrice = blend.oracle.getPriceFloat(leg.assetId);
  const asset = leg.meta?.asset;
  const key = asset
    ? stellarKey(asset.isNative() ? 'XLM' : asset.getCode(), asset.isNative() ? undefined : asset.getIssuer())
    : `soroban:${leg.assetId}`;
  if (oraclePrice !== undefined) book.set(key, oraclePrice, 'blend-oracle');
  return key;
}

/* ---------------------------------------------------------------- output */

const fmtUsd = (n) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtQty = (n) => {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 8 : abs < 1000 ? 6 : 2;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

const fmtPrice = (n) => {
  if (n === undefined) return '-';
  if (n !== 0 && Math.abs(n) < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 8 : 4 })}`;
};

function render(report, { color, showAll, minValue }) {
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const out = [];
  let total = 0;

  for (const section of report.sections) {
    const visible = section.rows.filter((r) => showAll || (r.amount !== 0 && Math.abs(r.usd) >= minValue));
    const hidden = section.rows.filter((r) => !visible.includes(r) && r.amount !== 0);
    const subtotal = section.rows.reduce((sum, r) => sum + r.usd, 0);
    total += subtotal;
    if (!visible.length && !hidden.length) continue;

    out.push('');
    out.push(bold(section.title));
    const table = visible
      .slice()
      .sort((a, b) => b.usd - a.usd)
      .map((r) => [r.label, fmtQty(r.amount), fmtPrice(r.price), fmtUsd(r.usd), r.source]);
    if (hidden.length) {
      const hiddenUsd = hidden.reduce((sum, r) => sum + r.usd, 0);
      table.push([`${hidden.length} position${hidden.length > 1 ? 's' : ''} under ${fmtUsd(minValue)}`, '', '', fmtUsd(hiddenUsd), '--all']);
    }
    const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...table.map((row) => row[i].length)));
    for (const row of table) {
      out.push(
        `  ${row[0].padEnd(widths[0])}  ${row[1].padStart(widths[1])}  ` +
        `${row[2].padStart(widths[2])}  ${row[3].padStart(widths[3])}  ${dim(row[4])}`,
      );
    }
    out.push(`  ${''.padEnd(widths[0])}  ${''.padStart(widths[1])}  ${'subtotal'.padStart(widths[2])}  ${bold(fmtUsd(subtotal).padStart(widths[3]))}`);
  }

  out.push('');
  out.push(bold(`TOTAL  ${fmtUsd(total)}`));

  if (report.unpriced.length) {
    out.push('');
    out.push(`No price source found, counted as $0 (${report.unpriced.length}):`);
    const shown = showAll ? report.unpriced : report.unpriced.slice(0, 10);
    for (const u of shown) out.push(`  ${u.label}  ${fmtQty(u.amount)}`);
    if (shown.length < report.unpriced.length) {
      out.push(`  ...and ${report.unpriced.length - shown.length} more (--all or --json to see them)`);
    }
  }
  if (warnings.length) {
    out.push('');
    out.push('Warnings:');
    for (const w of warnings) out.push(`  ${w}`);
  }
  return out.join('\n');
}

/* ---------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.flags.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig(opts);
  if (!config.stellar.length && !config.solana.length) {
    console.error('no wallets configured. pass --stellar/--solana or create wallets.json\n');
    console.error(USAGE);
    return 2;
  }

  const [stellarAccounts, blendPools, solanaAccounts] = await Promise.all([
    Promise.all(config.stellar.map((a) => readStellarAccount(a).catch((e) => {
      warn(`Stellar account ${a} failed: ${e.message}`);
      return { address: a, holdings: [], pools: [], claimables: [] };
    }))),
    Promise.all(config.blendPools.map((p) => readBlendPool(p, config.stellar).catch((e) => {
      warn(`Blend pool ${p} failed: ${e.message}`);
      return undefined;
    }))).then((list) => list.filter(Boolean)),
    Promise.all(config.solana.map((a) => readSolanaAccount(a).catch((e) => {
      warn(`Solana account ${a} failed: ${e.message}`);
      return { address: a, sol: 0, tokens: [] };
    }))),
  ]);

  const book = new PriceBook();

  for (const blend of blendPools) {
    for (const position of blend.positions) {
      for (const leg of position.legs) blendPriceKey(leg, blend, book);
    }
  }

  const stellarAssets = new Map();
  const addAsset = (code, issuer) => stellarAssets.set(stellarKey(code, issuer), { code, issuer });
  for (const account of stellarAccounts) {
    for (const h of account.holdings) addAsset(h.code, h.issuer);
    for (const pool of account.pools) for (const r of pool.reserves) addAsset(r.code, r.issuer);
    for (const c of account.claimables) addAsset(c.code, c.issuer);
  }
  for (const blend of blendPools) {
    const asset = blend.blndMeta.asset;
    if (asset) addAsset(asset.isNative() ? 'XLM' : asset.getCode(), asset.isNative() ? undefined : asset.getIssuer());
  }

  const mints = [...new Set(solanaAccounts.flatMap((a) => [WSOL, ...a.tokens.map((t) => t.mint)]))];

  const [, solanaMeta] = await Promise.all([
    priceFromStellarExpert(book, [...stellarAssets.values()])
      .then(() => priceFromHorizonPaths(book, [...stellarAssets.values()])),
    mints.length ? priceSolana(book, mints) : Promise.resolve(new Map()),
  ]);

  const report = buildReport(config, stellarAccounts, blendPools, solanaAccounts, book, solanaMeta);

  let gulps;
  if (opts.flags.has('gulp-emissions')) {
    const submit = opts.flags.has('submit');
    gulps = [];
    for (const blend of blendPools) {
      try {
        gulps.push(await gulpEmissions(blend.poolId, blend.version, config.stellar[0], submit));
      } catch (e) {
        gulps.push({ poolId: blend.poolId, submitted: false, error: e.message });
      }
    }
  }

  if (opts.flags.has('json')) {
    const total = report.sections.flatMap((s) => s.rows).reduce((sum, r) => sum + r.usd, 0);
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalUsd: total,
      sections: report.sections,
      unpriced: report.unpriced,
      gulpEmissions: gulps,
      warnings,
    }, null, 2));
  } else {
    console.log(render(report, {
      color: !opts.flags.has('no-color') && process.stdout.isTTY,
      showAll: opts.flags.has('all'),
      minValue: opts.minValue ?? 0.01,
    }));
    if (gulps) {
      console.log('');
      console.log(opts.flags.has('submit')
        ? `gulp_emissions (${gulps.filter((g) => g.submitted).length}/${gulps.length} submitted)`
        : 'gulp_emissions (simulation only, pass --submit to send)');
      for (const g of gulps) {
        if (g.error) {
          console.log(`  ${g.poolId}  FAILED  ${g.error}`);
        } else {
          console.log(
            `  ${g.poolId}  ${fmtQty(g.gulpedBlnd)} BLND  fee ${fmtQty(g.feeStroops / 1e7)} XLM` +
            `${g.hash ? `  tx ${g.hash} ${g.status}` : ''}`,
          );
        }
      }
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
