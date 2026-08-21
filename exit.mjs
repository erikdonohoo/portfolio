#!/usr/bin/env node
/**
 * Atomic exit from an XLM position: cancel the resting offers and sell, in one transaction.
 *
 * The reason this is one transaction rather than two commands is that XLM sitting in a sell
 * offer is locked. Cancelling and then selling as separate transactions leaves a window,
 * however brief, where the offer is gone and the sale has not happened, which is the worst
 * moment for the price to keep moving. Stellar runs a transaction's operations in order and
 * either all of them apply or none do, so the cancel frees the XLM for the sale in the same
 * atomic step.
 *
 * The sale is a strict-send path payment rather than an offer, because when you are exiting
 * you want a fill, not a queue position. destMin is the floor: if the book cannot do better
 * than your floor the whole transaction fails and you still hold everything, which is the
 * correct outcome. Slippage protection is not optional here.
 *
 * Previews by default. Nothing is signed or submitted without --send.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Horizon,
} from '@stellar/stellar-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvFile(join(HERE, '.env'));

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const USDC = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

const USAGE = `
exit - cancel resting XLM offers and sell, atomically

usage: node exit.mjs [options]

  --all                sell everything the reserve allows once offers are cancelled
  --sell <amount>      sell this much XLM instead
  --min-price <price>  floor in USDC per XLM. The transaction fails rather than fill below it
  --slippage <pct>     derive the floor from the current book instead (default 1)
  --keep <xlm>         hold back this much beyond the reserve (default 1)
  --keep-offers        sell without cancelling anything (only the spendable balance)
  --send               actually sign and submit. Without this it only previews
  --yes                skip the confirmation prompt
  -h, --help           this text

The cancel and the sale are operations in a single transaction, so there is never a moment
where the offer is gone and the XLM is unsold. If the book cannot meet the floor, nothing
happens at all.
`.trim();

function parseArgs(argv) {
  const opts = { slippage: 1, keep: 1, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--sell': opts.sell = Number(take()); break;
      case '--min-price': opts.minPrice = Number(take()); break;
      case '--slippage': opts.slippage = Number(take()); break;
      case '--keep': opts.keep = Number(take()); break;
      case '--all': case '--send': case '--yes': case '--keep-offers':
        opts.flags.add(arg.slice(2)); break;
      case '-h': case '--help': console.log(USAGE); process.exit(0);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.flags.has('all') && opts.sell === undefined) {
    throw new Error('say how much: --all or --sell <amount>');
  }
  if (opts.minPrice !== undefined && (!Number.isFinite(opts.minPrice) || opts.minPrice <= 0)) {
    throw new Error('--min-price must be a positive number');
  }
  return opts;
}

const stroops = (n) => n.toFixed(7);
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function loadKeypair() {
  const file = process.env.STELLAR_SECRET_KEY_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`STELLAR_SECRET_KEY_FILE not found: ${file}`);
    return Keypair.fromSecret(readFileSync(file, 'utf8').trim());
  }
  const secret = process.env.STELLAR_SECRET_KEY?.trim();
  if (!secret) throw new Error('set STELLAR_SECRET_KEY or STELLAR_SECRET_KEY_FILE in .env');
  return Keypair.fromSecret(secret);
}

async function confirm(question, auto) {
  if (auto) return true;
  if (!process.stdin.isTTY) throw new Error('not a TTY: pass --yes to run unattended');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const keypair = loadKeypair();
  const address = keypair.publicKey();
  const server = new Horizon.Server(HORIZON);

  const account = await server.loadAccount(address);
  const native = account.balances.find((b) => b.asset_type === 'native');
  const balance = Number(native.balance);
  const locked = Number(native.selling_liabilities);

  const offers = (await server.offers().forAccount(address).limit(50).call()).records;
  const xlmOffers = offers.filter((o) => o.selling.asset_type === 'native');
  const cancelling = opts.flags.has('keep-offers') ? [] : xlmOffers;

  // Cancelling an offer removes a subentry, which lowers the reserve. Size the sale against
  // the reserve as it will be *after* the cancels land, since they are in the same
  // transaction and apply first.
  const subentriesAfter = account.subentry_count - cancelling.length;
  const reserveAfter = (2 + subentriesAfter) * 0.5;
  const freedByCancel = cancelling.reduce((sum, o) => sum + Number(o.amount), 0);
  const available = balance - (locked - freedByCancel) - reserveAfter - opts.keep;

  const sellAmount = opts.flags.has('all') ? available : opts.sell;
  if (!(sellAmount > 0)) {
    throw new Error(`nothing to sell: ${stroops(available)} XLM available after reserve and --keep`);
  }
  if (sellAmount > available + 1e-7) {
    throw new Error(
      `cannot sell ${stroops(sellAmount)} XLM, only ${stroops(available)} available ` +
      `(balance ${stroops(balance)}, reserve ${reserveAfter}, keep ${opts.keep}` +
      `${cancelling.length ? '' : ', offers not being cancelled'})`,
    );
  }

  // What the book would actually pay, used both for the preview and to derive the floor.
  const paths = await server
    .strictSendPaths(Asset.native(), stroops(sellAmount), [USDC])
    .call();
  const best = paths.records.sort((a, b) => Number(b.destination_amount) - Number(a.destination_amount))[0];
  if (!best) throw new Error('no path from XLM to USDC for that size');
  const expected = Number(best.destination_amount);
  const expectedPrice = expected / sellAmount;

  const floorPrice = opts.minPrice ?? expectedPrice * (1 - opts.slippage / 100);
  const destMin = floorPrice * sellAmount;
  if (destMin > expected) {
    throw new Error(
      `the book pays ${stroops(expectedPrice)} per XLM but your floor is ${stroops(floorPrice)}. ` +
      'Lower --min-price or wait.',
    );
  }

  console.log('');
  console.log(`  account        ${address}`);
  console.log(`  XLM balance    ${stroops(balance)}   ${stroops(locked)} locked in offers`);
  if (cancelling.length) {
    for (const o of cancelling) {
      console.log(`  cancel         offer ${o.id}: ${o.amount} XLM at ${o.price}`);
    }
  } else if (xlmOffers.length) {
    console.log(`  keeping        ${xlmOffers.length} offer(s) in place (--keep-offers)`);
  }
  console.log(`  sell           ${stroops(sellAmount)} XLM`);
  console.log(`  book pays      ${usd(expected)} at ${expectedPrice.toFixed(7)} per XLM`);
  console.log(`  floor          ${usd(destMin)} at ${floorPrice.toFixed(7)} per XLM` +
    `${opts.minPrice === undefined ? ` (${opts.slippage}% slippage)` : ' (--min-price)'}`);
  console.log(`  hops           ${best.path.length ? best.path.map((a) => a.asset_code ?? 'XLM').join(' -> ') : 'direct'}`);
  console.log(`  keeping        ${stroops(balance - sellAmount)} XLM (reserve ${reserveAfter} + ${opts.keep})`);
  console.log('');

  if (!opts.flags.has('send')) {
    console.log('  preview only. re-run with --send to submit.');
    return 0;
  }
  if (!(await confirm(`Cancel ${cancelling.length} offer(s) and sell ${stroops(sellAmount)} XLM?`, opts.flags.has('yes')))) {
    console.log('aborted, nothing sent');
    return 0;
  }

  const builder = new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE?.trim() || String(Number(BASE_FEE) * 100),
    networkPassphrase: Networks.PUBLIC,
  });
  for (const o of cancelling) {
    builder.addOperation(Operation.manageSellOffer({
      selling: Asset.native(),
      buying: new Asset(o.buying.asset_code, o.buying.asset_issuer),
      amount: '0',
      price: o.price,
      offerId: o.id,
    }));
  }
  builder.addOperation(Operation.pathPaymentStrictSend({
    sendAsset: Asset.native(),
    sendAmount: stroops(sellAmount),
    destination: address,
    destAsset: USDC,
    destMin: stroops(destMin),
    path: best.path.map((a) => (a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code, a.asset_issuer))),
  }));

  const tx = builder.setTimeout(120).build();
  tx.sign(keypair);

  const sent = await server.submitTransaction(tx).catch((e) => {
    const codes = e?.response?.data?.extras?.result_codes;
    throw new Error(`submit failed: ${JSON.stringify(codes ?? e.message)}`);
  });

  console.log(`  done  https://stellar.expert/explorer/public/tx/${sent.hash}`);
  const after = await server.loadAccount(address);
  const usdcAfter = after.balances.find((b) => b.asset_code === 'USDC');
  console.log(`  USDC balance now ${usdcAfter?.balance ?? '0'}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`exit: ${e.message}`);
    process.exit(1);
  },
);
