# portfolio-value

One command that adds up what your Stellar and Solana wallets are worth in USD, including
Blend lending positions and backstop deposits.

## Run it

```bash
npm install
node portfolio.mjs
```

Anywhere with Node 18+ and network access. No API keys.

```
Stellar wallet GDQQBII7E3LJJALSQ2YMOVKV3SJ57XO4YWBDWIPRWEV3HN4P36V642VN
  BLND   1,745.37  $0.04136717  $72.20  stellar.expert
  USDC  18.898081        $1.00  $18.90  stellar.expert
  XLM    5.198882  $0.15765197   $0.82  stellar.expert
                      subtotal  $91.92

Blend V2 pool "Etherfuse" supplied - CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI
  CETES                       22,132.88  $0.06914413  $1,530.36  blend-oracle
  USTRY                        1,391.76      $1.0724  $1,492.48  blend-oracle
  BLND emissions (unclaimed)   4.995358  $0.04136717      $0.21  stellar.expert
                                            subtotal  $3,023.04
...
TOTAL  $4,305.64
```

The last column is the price source for that row, so you can always see where a number came from.

## Wallets

`wallets.json` next to the script holds the addresses:

```json
{
  "stellar": ["GDQQ...42VN"],
  "solana": ["ERFP...udwA"],
  "blendPools": ["CDMA...PVAI"]
}
```

Every field takes a list, so add as many wallets as you like. `--stellar`, `--solana` and
`--blend-pool` add more for a single run, and `--config <path>` points at a different file
(or set `PORTFOLIO_CONFIG`). Blend pools are checked for every Stellar address you list.

## Options

| flag | effect |
| --- | --- |
| `--min-value <usd>` | collapse positions worth less than this into one line (default `0.01`) |
| `--all` | show everything, including zero balances and dust |
| `--json` | machine-readable output, with every row and warning |
| `--no-color` | plain text |
| `--gulp-emissions` | simulate `gulp_emissions()` on each Blend pool (read-only) |
| `--submit` | with `--gulp-emissions`, actually sign and send |

Endpoints are overridable: `HORIZON_URL`, `STELLAR_RPC_URL`, `SOLANA_RPC_URL`. The defaults are
the public ones, which are rate limited; point them at your own if you run this on a schedule.

## What it counts

**Stellar** (Horizon): XLM, every trustline balance, liquidity pool shares broken down into
their underlying reserves, and claimable balances.

**Blend** (Soroban, via `@blend-capital/blend-sdk`): supplied and collateral positions,
**minus anything you have borrowed**, so a pool line is your net position. Plus your backstop
deposit valued at the BLND-USDC Comet LP price, any withdrawal you have queued (still yours
until you claim it), and unclaimed BLND emissions on both the pool and the backstop side.

**Solana** (JSON-RPC): SOL plus every SPL and Token-2022 balance the wallet holds.

## How assets get priced

Nothing is hardcoded per token. Each asset is resolved through a chain of sources and the
first one that answers wins:

**Stellar**
1. The Blend pool's own on-chain oracle, for assets that are reserves in a pool you listed.
2. `api.stellar.expert` unit price.
3. A Horizon `strict-send` path quote to USDC for **one unit** of the asset. Quoting a single
   unit is deliberate: quoting the whole position would fold slippage into the price and
   undervalue anything on a thin book. On this wallet, a full-position quote priced BLND 11%
   below its market price.

Soroban tokens are resolved to their underlying classic asset via the token contract's
metadata, so a Stellar Asset Contract prices the same way its classic asset does.

**Solana**
1. Jupiter (`tokens/v2/search`), which returns symbol, decimals and USD price together.
2. DexScreener, taking the deepest pool per mint.

Anything no source can price is listed separately and counted as **$0**, never guessed at.

## Caveats worth knowing

- **The DexScreener fallback is only as trustworthy as the pool it reads.** Anyone can create
  a token called USDC and a pool to trade it. Pools shallower than $1,000 are ignored
  (`MIN_DEX_LIQUIDITY_USD`), but a wash-traded pair can still clear that bar. Jupiter is
  preferred for exactly this reason; check the source column if a number looks wrong.
- Public RPC endpoints rate limit. The script retries with backoff, but a large wallet run in
  a loop will still get 429s. Use your own endpoints for that.
- Not counted: staked SOL, Solana positions inside other protocols, NFTs, and open DEX offers.

## gulp_emissions

`gulp_emissions()` is the permissionless Blend call that pulls emissions from the backstop into
a pool and distributes them across its reserves. It is safe for anyone to call; it moves nothing
of yours and only costs the transaction fee.

Dry run, which needs no key:

```bash
node portfolio.mjs --gulp-emissions
```

```
gulp_emissions (simulation only, pass --submit to send)
  CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI  1,901.6 BLND  fee 0.023051 XLM
```

To actually send it, supply a signing key and opt in explicitly:

```bash
STELLAR_SECRET_KEY=S... node portfolio.mjs --gulp-emissions --submit
```

It simulates first either way, so a call that would fail never reaches the network.

### Where to put the key

The key is only ever read from the environment, never a flag and never `wallets.json`, so it
cannot end up in the repo. Three ways in, best first:

```bash
# 1. from a password manager, so it never touches disk or shell history
STELLAR_SECRET_KEY=$(op read "op://Private/Stellar/secret key") \
  node portfolio.mjs --gulp-emissions --submit

# 2. from a gitignored file
echo 'S...' > ~/.stellar-gulp-key && chmod 600 ~/.stellar-gulp-key
STELLAR_SECRET_KEY_FILE=~/.stellar-gulp-key node portfolio.mjs --gulp-emissions --submit

# 3. inline, which does land in shell history
STELLAR_SECRET_KEY=S... node portfolio.mjs --gulp-emissions --submit
```

**It does not have to be the key for the wallet you are valuing.** `gulp_emissions` is
permissionless and touches none of your positions, so the signer can be any funded account.
Use a throwaway with a few XLM in it and your main key never comes near this script.
