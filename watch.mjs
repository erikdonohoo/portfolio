#!/usr/bin/env node
/**
 * Price watcher for a Stellar DEX pair. Alerts by default; with --exit it also sells.
 *
 * The point is to answer "what would I actually get right now", not "what did the last
 * trade print". A single 0.39 XLM offer at the top of the book is not a price you can sell
 * into, so the check walks the book for a real size and uses the average fill. That makes
 * it immune to the thin wick that would otherwise fire a false alarm.
 *
 * Two failure modes get explicit attention, because a watcher that dies quietly is worse
 * than no watcher at all:
 *   - repeated crossings: alert once, then stay quiet until the price recovers past a
 *     rearm band, so a price sitting on the threshold does not alert every poll
 *   - going blind: if Horizon stops answering, say so rather than looking calm
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';

// Assets you can name directly instead of spelling out CODE:ISSUER.
const KNOWN = {
  XLM: { native: true },
  USDC: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  EURC: { code: 'EURC', issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2' },
  BLND: { code: 'BLND', issuer: 'GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY' },
  CETES: { code: 'CETES', issuer: 'GDCUV4WNJKQ7LMDBHDXXNQMDHVHYJIRLQ6BBPRPCEVSC2LGVSNZRLXMA' },
  USTRY: { code: 'USTRY', issuer: 'GBET6JZBQ7ZQNQIVWQ2SFTQOBXZTIFJIRJZKF5KTIWSJKHRZFTOGDNZK' },
  TESOURO: { code: 'TESOURO', issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC' },
};

const USAGE = `
watch - alert when a Stellar DEX pair crosses a price

usage: node watch.mjs --pair XLM/USDC --below 0.18 [options]

  --pair <A/B>       what you would sell / what you would receive (e.g. XLM/USDC).
                     Either side may be CODE:ISSUER for an asset not in the built-in list.
  --below <price>    alert when the realizable price falls to or under this
  --above <price>    alert when it rises to or over this
  --size <amount>    how much of A to price, so the check reflects a fill you could
                     actually get rather than the top offer (default 1)
  --every <seconds>  poll interval (default 60)
  --rearm <pct>      how far back past the threshold the price must move before a second
                     alert can fire, as a percent (default 0.5)
  --once             exit after the first alert
  --quiet            only print alerts and problems, not every poll
  -h, --help         this text

Acting on the alert (opt in, and it sells real funds):

  --exit             on alert, run exit.mjs: cancel resting offers on this pair and sell
  --exit-min-price   hard floor for that sale. Defaults to 20% under the threshold, which
                     is wide enough that it cannot block a fill in a normal book but still
                     refuses to sell into an evaporated one
  --exit-size        how much to sell (default: everything the reserve allows)

Without --exit this script only reads: it places no offers and moves no funds.
`.trim();

function parseAsset(spec) {
  if (KNOWN[spec.toUpperCase()]) return KNOWN[spec.toUpperCase()];
  const [code, issuer] = spec.split(':');
  if (!code || !issuer) throw new Error(`asset must be a known code or CODE:ISSUER, got: ${spec}`);
  return { code, issuer };
}

function parseArgs(argv) {
  const opts = { size: 1, every: 60, rearm: 0.5, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--pair': opts.pair = take(); break;
      case '--below': opts.below = Number(take()); break;
      case '--above': opts.above = Number(take()); break;
      case '--size': opts.size = Number(take()); break;
      case '--every': opts.every = Number(take()); break;
      case '--rearm': opts.rearm = Number(take()); break;
      case '--once': case '--quiet': case '--exit': opts.flags.add(arg.slice(2)); break;
      case '--exit-min-price': opts.exitMinPrice = Number(take()); break;
      case '--exit-size': opts.exitSize = Number(take()); break;
      case '-h': case '--help': console.log(USAGE); process.exit(0);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.pair) throw new Error('--pair is required (e.g. --pair XLM/USDC)');
  if (opts.below === undefined && opts.above === undefined) {
    throw new Error('give a threshold: --below <price> or --above <price>');
  }
  if (opts.below !== undefined && opts.above !== undefined) {
    throw new Error('use one of --below or --above, not both');
  }
  if (opts.flags.has('exit') && opts.above !== undefined) {
    throw new Error('--exit is for getting out on a fall, so pair it with --below');
  }
  if (opts.exitMinPrice !== undefined && !(opts.exitMinPrice > 0)) {
    throw new Error('--exit-min-price must be positive (Stellar rejects a zero floor)');
  }
  for (const [name, v] of [['--size', opts.size], ['--every', opts.every], ['--rearm', opts.rearm]]) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  }
  return opts;
}

const assetParams = (prefix, asset) =>
  asset.native
    ? `${prefix}_asset_type=native`
    : `${prefix}_asset_type=credit_alphanum${asset.code.length > 4 ? 12 : 4}` +
      `&${prefix}_asset_code=${asset.code}&${prefix}_asset_issuer=${asset.issuer}`;

/**
 * Average price for selling `size` of the base asset into the current bids, plus how much
 * of that size the book can actually absorb. A partially fillable size is reported rather
 * than silently averaged over less than asked.
 */
async function realizablePrice(sell, buy, size) {
  const url =
    `${HORIZON}/order_book?${assetParams('selling', sell)}&${assetParams('buying', buy)}&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const book = await res.json();

  const bids = book.bids ?? [];
  if (!bids.length) return { price: undefined, filled: 0, topBid: undefined };

  let filled = 0;
  let proceeds = 0;
  for (const level of bids) {
    if (filled >= size) break;
    const price = Number(level.price);
    const take = Math.min(Number(level.amount), size - filled);
    filled += take;
    proceeds += take * price;
  }
  return {
    price: filled > 0 ? proceeds / filled : undefined,
    filled,
    topBid: Number(bids[0].price),
  };
}

function notify(title, message) {
  process.stdout.write('\u0007'); // terminal bell
  if (process.platform !== 'darwin') return;
  const escape = (s) => s.replace(/["\\]/g, '\\$&');
  execFile('osascript', ['-e', `display notification "${escape(message)}" with title "${escape(title)}" sound name "Sonumi"`], () => {});
}

const stamp = () => new Date().toLocaleString('sv-SE').replace(',', '');

/**
 * Hand the selling off to exit.mjs rather than reimplementing it, so there is exactly one
 * code path that moves funds and it is the same one you can run and preview by hand. The
 * command is printed before it runs, so the log shows precisely what was executed.
 */
function runExit({ minPrice, size }) {
  const args = [join(HERE, 'exit.mjs'), '--min-price', String(minPrice), '--send', '--yes'];
  if (size === undefined) args.push('--all');
  else args.push('--sell', String(size));

  console.log(`${stamp()}  running: node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  return new Promise((resolve) => {
    const child = execFile('node', args, { cwd: HERE }, (error, stdout, stderr) => {
      if (stdout.trim()) console.log(stdout.trimEnd());
      if (stderr.trim()) console.log(stderr.trimEnd());
      resolve(!error);
    });
    child.stdin?.end();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [sellSpec, buySpec] = opts.pair.split('/');
  if (!sellSpec || !buySpec) throw new Error('--pair looks like XLM/USDC');
  const sell = parseAsset(sellSpec);
  const buy = parseAsset(buySpec);
  const label = `${sellSpec.toUpperCase()}/${buySpec.toUpperCase()}`;

  const watchingBelow = opts.below !== undefined;
  const threshold = watchingBelow ? opts.below : opts.above;
  // Only rearm once the price has clearly left the threshold, so a price hovering on it
  // does not alert on every poll.
  const rearmAt = watchingBelow
    ? threshold * (1 + opts.rearm / 100)
    : threshold * (1 - opts.rearm / 100);

  // A floor wide enough that it cannot block a fill in a functioning book, but still
  // refuses to dump the position into one that has emptied out.
  const exitFloor = opts.exitMinPrice ?? threshold * 0.8;

  console.log(`watching ${label} for ${watchingBelow ? 'a fall to' : 'a rise to'} ${threshold}`);
  console.log(`  priced on a ${opts.size} ${sellSpec.toUpperCase()} fill, every ${opts.every}s, rearm at ${rearmAt.toFixed(7)}`);
  if (opts.flags.has('exit')) {
    console.log('');
    console.log('  *** ARMED TO SELL ***');
    console.log(`  on alert it will cancel resting ${sellSpec.toUpperCase()} offers and sell` +
      `${opts.exitSize === undefined ? ' the whole position' : ` ${opts.exitSize} ${sellSpec.toUpperCase()}`}`);
    console.log(`  floor ${exitFloor.toFixed(7)} per ${sellSpec.toUpperCase()}` +
      `${opts.exitMinPrice === undefined ? ' (20% under the threshold, override with --exit-min-price)' : ' (--exit-min-price)'}`);
    console.log('  leave this running. it cannot act while it is not running.');
  } else {
    console.log('  reads only: no offers are placed and no funds move');
  }
  console.log('');

  let armed = true;
  let consecutiveFailures = 0;
  let blindAlerted = false;

  for (;;) {
    try {
      const { price, filled, topBid } = await realizablePrice(sell, buy, opts.size);
      consecutiveFailures = 0;
      if (blindAlerted) {
        console.log(`${stamp()}  horizon is answering again`);
        blindAlerted = false;
      }

      if (price === undefined) {
        console.log(`${stamp()}  no bids on ${label}`);
      } else {
        const short = filled + 1e-9 < opts.size ? `  (book only absorbs ${filled.toFixed(4)})` : '';
        const crossed = watchingBelow ? price <= threshold : price >= threshold;

        if (crossed && armed) {
          const message =
            `${label} ${watchingBelow ? 'fell to' : 'reached'} ${price.toFixed(7)} ` +
            `for ${opts.size} ${sellSpec.toUpperCase()} (threshold ${threshold})`;
          console.log(`${stamp()}  *** ALERT *** ${message}${short}`);
          notify(`${label} ${watchingBelow ? 'below' : 'above'} ${threshold}`, message);
          armed = false;

          if (opts.flags.has('exit')) {
            const ok = await runExit({ minPrice: exitFloor, size: opts.exitSize });
            if (ok) {
              notify(`${label} position closed`, `sold at or above ${exitFloor.toFixed(7)}`);
              console.log(`${stamp()}  exited. nothing left to watch.`);
              return 0;
            }
            // A failed exit is the one case worth shouting about: the trigger fired, the
            // sale did not happen, and the position is still open.
            notify(`${label} EXIT FAILED`, 'The trigger fired but the sale did not go through. You are still holding.');
            console.log(`${stamp()}  exit FAILED, still holding. staying up to retry on the next crossing.`);
            armed = true;
          } else if (opts.flags.has('once')) {
            return 0;
          }
        } else if (!armed && (watchingBelow ? price >= rearmAt : price <= rearmAt)) {
          console.log(`${stamp()}  recovered to ${price.toFixed(7)}, alert rearmed`);
          armed = true;
        } else if (!opts.flags.has('quiet')) {
          console.log(
            `${stamp()}  ${price.toFixed(7)}  top bid ${topBid.toFixed(7)}  ` +
            `${watchingBelow ? 'need' : 'need'} ${threshold}${armed ? '' : '  (alerted, waiting to rearm)'}${short}`,
          );
        }
      }
    } catch (e) {
      consecutiveFailures++;
      console.log(`${stamp()}  cannot read the book: ${e.message} (${consecutiveFailures} in a row)`);
      // A watcher that has gone blind looks identical to a calm market, so say so loudly.
      if (consecutiveFailures >= 5 && !blindAlerted) {
        notify(`${label} watcher is blind`, `${consecutiveFailures} failed polls in a row. The price is not being checked.`);
        blindAlerted = true;
      }
    }
    await new Promise((r) => setTimeout(r, opts.every * 1000));
  }
}

main().catch((e) => {
  console.error(`watch: ${e.message}`);
  process.exit(1);
});
