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

`wallets.json` next to the script holds the addresses. It is gitignored, so copy the example and
put your own in:

```bash
cp wallets.json.example wallets.json
```

```json
{
  "stellar": ["GABC...YOUR_STELLAR_ACCOUNT"],
  "solana": ["YourSolanaWalletAddress11111111111111111111"],
  "blendPools": ["CDMA...PVAI", "CAJJ...BXBD"]
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
| `--rates` | every Blend reserve's estimated supply and borrow APY, across all pools |
| `--gulp-emissions` | simulate `gulp_emissions()` on each Blend pool (read-only) |
| `--submit` | with `--gulp-emissions`, actually sign and send |

Endpoints are overridable: `HORIZON_URL`, `STELLAR_RPC_URL`, `SOLANA_RPC_URL`. The defaults are
the public ones, which are rate limited; point them at your own if you run this on a schedule.

Blend position rows carry an APY column: `+` is what you earn on a supplied balance, `-` is what
you pay on a borrowed one. A reserve you are both supplied and borrowed in shows both, since
neither figure alone describes the position.

The figure is **all-in, including BLND emissions**, with the split in parentheses so you can see
how much of a rate depends on a reward programme that expires:

```
TESOURO   3,742.79  $0.23969075  $897.11  +4.93% (1.32+3.61)
```

That is 1.32% interest plus 3.61% emissions. Emissions on the borrow side are a rebate rather
than a cost, so they subtract: a 10.92% borrow rate with 0.29% emissions shows as
`10.63% (10.92-0.29)`. Expired emissions count as zero.

`--rates` adds a table of every reserve in every configured pool, held or not, with the same
breakdown plus utilization and the date emissions run out. That is the view for deciding where
to move a balance.

### Unclaimed emissions

Accrued BLND is listed on its own line below the positions, in both the pool and the backstop
sections. It is deliberately kept out of the position rows and exempt from `--min-value`: a
claimable reward that reads as `$0.00` because it is worth less than a cent is still something
you can act on, and collapsing it into "1 position under $0.01" makes it look like nothing has
accrued at all.

```
USDC (net of 1,000 borrowed)         -1,000      $1.0004  -$1,000.42              -2.70%  blend-oracle
unclaimed emissions           0.203935 BLND  $0.04200468       $0.01                      claim-simulated
                                                  subtotal   $2,301.80
```

The `claim-simulated` source means the figure came from simulating the pool's own `claim` call,
which is the authority and the same number Blend's UI shows. The SDK ships an `estimateEmissions`
helper that reimplements the accrual, but it lands a hair off, so it is only used as a fallback
when the simulation cannot run; the source column says `blend-sdk-estimate` when that happens.

## What it counts

**Stellar** (Horizon): XLM, every trustline balance, liquidity pool shares broken down into
their underlying reserves, and claimable balances. A balance with XLM or tokens committed to a
DEX offer is labelled `(N in offers)`. Horizon's balance already includes that amount, so the
total is right either way, but a balance that is mostly spoken for reads very differently from a
free one.

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

Note that source 2 and source 3 can disagree meaningfully, because they measure different
things. stellar.expert aggregates across venues, including the exchanges where most XLM
actually trades; a Horizon path quote is the price on the SDEX order book, which is the only
place a Stellar-held balance can actually be sold. In August 2026 those differed by 1.8% on
XLM, with SDEX at a premium. Neither is wrong. If you care what a position would fetch on
Stellar today, the path quote is the relevant one; if you care what the asset is worth in the
wider market, stellar.expert is.

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

## Bridging USDC from Solana to Stellar

`bridge.mjs` moves native USDC between Solana and Stellar over Circle's CCTP V2, in either
direction. Burn and mint, no wrapped asset and no third-party bridge. It drives all three steps
itself:

```bash
node bridge.mjs --amount 0.5                  # Solana -> Stellar
node bridge.mjs --from stellar --amount 0.5   # Stellar -> Solana
```

Going to Stellar:

1. `deposit_for_burn_with_hook` on Solana (CCTP domain 5), which burns the USDC
2. polling Circle's Iris API until the burn is attested
3. `mint_and_forward` on Stellar's `CctpForwarder` (CCTP domain 27), which mints and delivers

Coming back:

1. `approve` then `deposit_for_burn` on Stellar's `TokenMessengerMinter`
2. the same Iris poll, against domain 27
3. `receive_message` on Solana's `MessageTransmitterV2`, which mints into a token account

### The one thing to understand first

Stellar's 32-byte address encoding cannot distinguish an account from a contract, so CCTP always
reads `mintRecipient` as a **contract**. Minting straight to a `G...` account is impossible.
Instead `mintRecipient` and `destinationCaller` are both set to Circle's `CctpForwarder`, and your
real recipient rides along in the hook data as a UTF-8 strkey. The forwarder mints to itself and
transfers onward in the same transaction.

Circle's docs are blunt about the failure mode: if `destinationCaller` is wrong, nothing can
complete the transfer and the funds are unrecoverable. The script hardcodes both fields to the
forwarder and re-checks them against the attested message before it will submit the mint.

### Two more gotchas, on the way back

**The mint recipient on Solana is a token account, not a wallet.** Exact mirror of the Stellar
problem. Pass `--to <wallet>` and the script derives the associated token account for you, but
that account has to exist already: CCTP will not create it, and preflight refuses to burn until
it does.

**Leaving Stellar needs an `approve` first.** `deposit_for_burn` pulls your USDC with
`transfer_from` rather than under your transaction's own authorization, so it needs a standing
allowance. Circle's source says so directly:

> Uses `transfer_from` which requires the caller to have previously approved this contract to
> spend tokens on their behalf via `token.approve()`.

Soroban allows one contract call per transaction, so this is a second Stellar transaction. The
script approves exactly the burn amount, which `deposit_for_burn` then consumes back to zero.
If a burn fails after its approve landed, the allowance is left standing until it expires about
a day later. Clear it early with:

```bash
node bridge.mjs --revoke-allowance
```

**A Solana address lookup table gets created on your first inbound transfer.** A Stellar-origin
message is 376 bytes and its attestation another 130, which puts a plain `receive_message`
transaction at 1266 bytes against Solana's 1232-byte limit. It does not fit. A lookup table
swaps each 32-byte account key for a 1-byte index and brings the same transaction down to 897
bytes. The script builds one automatically, caches it in `.bridge/lookup-table.json`, and reuses
it for every transfer after that.

### Setup

```bash
cp .env.example .env   # then fill it in
```

You need two keys, and they are unrelated:

- **`SOLANA_SECRET_KEY`** (or `SOLANA_KEYPAIR_FILE`) is the account holding the USDC. It signs
  the burn and pays Solana fees plus rent for the `MessageSent` account.
- **`STELLAR_SECRET_KEY`** (or `STELLAR_SECRET_KEY_FILE`) only submits the mint and pays the XLM
  fee. It does not have to be the recipient, so a throwaway with a couple of XLM works.

`STELLAR_RECIPIENT` is where the USDC lands. A `G...` account needs a USDC trustline
(`USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`) before you start; the script
refuses to burn without one, because the forward leg would fail on arrival.

### Run it

Dry run first. It runs every preflight check and simulates the burn against mainnet, but sends
nothing:

```bash
node bridge.mjs --amount 0.5 --dry-run
```

Preflight verifies that Solana has Stellar registered as domain 27, that the token messenger it
has registered there is the same contract the mint step talks to, that your USDC balance and
trustline headroom cover the amount, and that both fee payers are funded.

Then for real:

```bash
node bridge.mjs --amount 0.5
```

It prints the whole route and waits for a `y` before burning anything. After the burn it writes
`.bridge/<signature>.json` (gitignored) and polls for the attestation. Standard transfers wait for
Solana finality, so budget a few minutes.

### If something breaks after the burn

The burn is the only irreversible step, and everything after it is resumable. The state file holds
the signature, the `MessageSent` account, and the attested message once it arrives:

```bash
node bridge.mjs --resume <solana-tx-signature>   # re-attest if needed, then mint
node bridge.mjs --list                           # every transfer and where it got to
```

If you already have the message and attestation from elsewhere:

```bash
node bridge.mjs --mint-only --message 0x... --attestation 0x...
```

Attestations do not expire, so a mint can be finished days later.

### Costs

Solana to Stellar, measured on a real 0.5 USDC transfer that took 29 seconds end to end:

| leg | cost | gone for good? |
| --- | --- | --- |
| CCTP protocol fee | 0 USDC | n/a, and read from chain each run in case Circle ever sets one |
| Solana signature fee | 0.00001 SOL (two signers) | yes |
| Solana `MessageSent` rent | 0.004482 SOL | no, refundable after 5 days |
| Stellar `mint_and_forward` | 0.0282636 XLM | yes |

Stellar to Solana. The Stellar `approve` fee is from a mainnet simulation; the burn fee is not
measured yet, and the Soroban resource fee will be in the same range as `mint_and_forward`:

| leg | cost | gone for good? |
| --- | --- | --- |
| Stellar `approve` | 0.0058 XLM | yes |
| Stellar `deposit_for_burn` | a few hundredths of an XLM | yes |
| Solana signature fee | 0.000005 SOL | yes |
| Solana `used_nonce` rent | 0.000954 SOL | **yes**, this one is permanent, it is what stops replays |
| lookup table rent | 0.004621 SOL | no, one time only and closable |

Neither direction scales with the amount: bridging 5,000 USDC costs the same as bridging 0.5.

The Solana rent is a rent-exemption deposit, not a fee. It keeps the 516-byte account holding
your CCTP message alive so Circle's attestation service can read it, and it comes back in full
to whoever paid it.

### Reclaiming rent

Circle gates this behind a 5-day window, enforced on chain by `EventAccountWindowNotExpired`.
The reason is specific to CCTP V2: the unique nonce is no longer part of the source message, so
when you ask to close an account the program can only check that the attestation you supplied
hashes to the same *source fields*, which is not unique to that account. It cannot prove your
message was attested, so it waits long enough to be sure the service has read it instead.

Sweep everything that is old enough, without having to remember any signatures:

```bash
node bridge.mjs --reclaim-all
```

```
  2Di3qhRE..wXVjNe  skipped: 119.9h to go, opens 2026-08-24 17:56Z

1 still inside the 5-day window, holding 0.004482 SOL
```

It walks `.bridge/`, skips anything already closed, not yet attested, still inside the window,
or burned on Stellar (which creates no such account), and sends one transaction per eligible one. A reclaim instruction carries the whole
message plus attestation, so two of them will not fit in Solana's 1232-byte transaction limit.
A single failure is reported and the sweep carries on. `--reclaim <signature>` still does one.

### Decimals

Stellar USDC has 7 decimals; every other CCTP chain has 6. CCTP messages always carry 6, and the
Stellar `TokenMessengerMinter` scales by 10 on arrival. `--amount` is plain USDC and the script
handles the rest. Going the other way, a burn on Stellar only reaches through the 6th decimal
and leaves the 7th behind as dust; the script rounds down before asking you to confirm, and
tells you how much is staying put, so the number you approve is the number that moves.

### Addresses

All of these were checked against mainnet, not just copied from documentation. The clincher is
that the Stellar token messenger Solana has registered for domain 27 hashes to exactly Circle's
published Stellar `TokenMessengerMinter`, which pins the whole route down.

| chain | contract |
| --- | --- |
| Solana | `TokenMessengerMinterV2` `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| Solana | `MessageTransmitterV2` `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| Solana | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Stellar | `CctpForwarder` `CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T` |
| Stellar | `TokenMessengerMinter` `CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL` |
| Stellar | `MessageTransmitter` `CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV` |

Mainnet only, deliberately. Testnet would mean shipping a second set of addresses that this
script has never exercised.

## What have I actually gained

`portfolio.mjs` says what the wallets are worth. `ledger.mjs` says how much of that you put
in yourself:

```bash
node ledger.mjs --refresh   # fetch new history, then report
node ledger.mjs             # report from cache
node ledger.mjs --flows     # list every external flow
```

```
put in                  $3,967.85   20 transfers in
taken out                 $132.93   8 transfers out
worth today             $4,282.07

gain                      $447.15   +11.27%
your money still in     $3,834.92   put in, less what you took back out

  by chain              put in    taken out   worth today    gain/loss   return
  stellar            $3,876.58        $1.64     $4,276.74      $401.80   +10.36%
  solana               $448.93      $488.95         $5.33       $45.35   +10.10%
```

A leg is judged on what it gave back plus what it still holds, against everything ever put
into it: `gain = takenOut + worthToday - putIn`. Money bridged between the wallets counts as
taken out of the sending chain and put into the receiving one, which is what makes the two rows
add back to the total. Percentages are always signed, so a losing leg reads as one.

### How it decides what counts

Only money crossing the boundary of your wallets counts. Swaps, Blend supply and withdraw,
borrows and repayments all move balances around without changing what you are worth, so they
are ignored. Concretely:

- **Stellar**: external flows are plain `payment` and `create_account` ops with a counterparty
  that is not you. Path payments are self-to-self swaps. Soroban invocations are Blend or the
  bridge, and Horizon reports them with no amount at all, which is a fair hint they are not
  payments in the ordinary sense.
- **Solana**: inferred from per-transaction balance deltas, since the data carries no
  payment/swap distinction. One asset down and another up in the same transaction is a swap.
  The fee is added back first, and sub-0.03 SOL moves are treated as rent noise, so closing a
  token account does not read as a withdrawal.
- **Between your own wallets**: an outflow on one chain that reappears on the other within six
  hours, same asset, within 2%, is the same money moving. Those pairs cancel instead of counting
  as a withdrawal plus a fresh deposit. This is what catches the CCTP bridge.

Stellar bridge arrivals are found through `/effects` rather than `/payments`, because a Soroban
`mint_and_forward` produces an `account_credited` effect but a payment record with no amount.
Effects are used only for this matching, never to classify external flows, since they also fire
for every swap leg.

### Valuation and its limits

Flows are valued on the day they happened, from whichever source knows that asset best:

| asset | source | precision |
| --- | --- | --- |
| USDC, USDT, EURC | par | n/a |
| CETES, TESOURO, USTRY and the other Etherfuse bonds | `GET /lookup/bonds/history/{mint}`, `tokenPrice / usdExchangeRate` | daily |
| MXNe | pegged 1:1 to the peso, so the ECB USD/MXN fixing | daily |
| XLM and any classic Stellar asset | Horizon `/trade_aggregations` against USDC, volume weighted | **hourly** |
| SOL, BTC, ETH | Coinbase public candles | **hourly** |
| anything else with a CoinGecko id | CoinGecko history, last 365 days only | daily |

Stellar assets are priced off the SDEX rather than an off-network aggregate, for the same
reason `portfolio.mjs` is: that is the venue the balance can actually be sold on. It also
has no rate limit and can be asked for the specific hour a transfer landed, which matters on
a volatile day. The 2025-11-21 XLM deposit prices at 0.2384205, the volume-weighted average
of the 887 trades in that hour, against CoinGecko's 0.236809 for the day as a whole.

Mints come from `GET /lookup/tokens/cost`. Everything lands in `.ledger/` because a past day's
price never changes. Anything still unpriced is counted as **$0** and listed explicitly rather
than guessed at, the same policy `portfolio.mjs` uses.

The bond series is the one cache with no cursor: that endpoint returns the whole series every
time. So when a flow needs a date the cached series does not reach, it refetches once per symbol
rather than carrying the last known price forward, which would silently understate anything
accrued since. A price is only reported as unavailable if a fresh pull still does not cover the
date. A fetch failure and a genuinely unknown price are also reported differently, because
treating them the same is how a rate limit becomes a quietly wrong total.

### Why an unpriced flow is not a rounding error

A flow counted as $0 does not just lose a little precision, it corrupts the answer in a known
direction. `gain = tookOut + worthToday - putIn`, so **an inflow valued at $0 inflates the gain
one for one**: real money entered as nothing, left as something, and the difference is reported
as profit that was never earned. An unpriced outflow pushes the other way.

This is not hypothetical. CoinGecko's free tier refuses anything older than 365 days
(`error_code 10012`), so every 2024 flow priced at $0 and one wallet reported a **+301%** Solana
return that was mostly a handful of unpriced SOL deposits. Coinbase's candles need no key and go
back years, which is why they now come first for the assets they cover.

For anything still unpriced the report says so, splits the count by direction, and states which
way the number is wrong rather than printing a confident percentage. Memecoins with no listing
anywhere will always land here.

Two things this number is not:

- **It is not a time-weighted return.** Deposits landed on different dates, so 11.65% is total
  gain over contributions, not an annualized rate. Money that arrived in March has not been
  working as long as money from November.
- **It assumes every external counterparty is a third party.** A transfer to another wallet you
  own that is not in `wallets.json` reads as a withdrawal. Add every wallet you control.

History is cached under `.ledger/` (gitignored). Both chains are append-only, so a refresh only
fetches what is new: Stellar resumes from the stored Horizon cursor, Solana stops walking
signatures once it reaches the newest one already cached, and mints only resolve symbols not seen
before. `--refresh` prints what each source holds and how much of it is new. The first run walks
everything and takes a few minutes on public endpoints.

## Watching a price, and getting out

Two small tools for a directional position on the SDEX. They are separate on purpose: one
only looks, the other only acts, and neither does both.

### watch.mjs

```bash
node watch.mjs --pair XLM/USDC --below 0.18 --size 535 --every 60
```

Polls the order book and alerts to the terminal, the bell, and a macOS notification when the
price crosses. It reads only: it places no offers and moves no funds.

`--size` is the flag worth understanding. Without it the check uses the top of the book, which
can be a rounding error of volume: this pair's best bid was 0.39 XLM deep at one point and 520
XLM deep an hour later. Passing your position size prices the fill you could actually get, so a
thin top level cannot trigger a false alarm. That matters most during a fast move, which is
exactly when a thin top level is likeliest.

Add `--exit` and it acts on the alert instead of just reporting it: cancels the resting offers
on that pair and sells, by shelling out to `exit.mjs` so there is exactly one code path that
moves funds and it is the same one you can preview by hand. The command it runs is printed
before it runs. It prints a loud `*** ARMED TO SELL ***` banner at startup, and it stops after a
successful exit because there is nothing left to watch.

A failed exit is the case it shouts loudest about. The trigger fired, the sale did not land, and
you are still holding: it says so, notifies separately, and stays up to retry on the next
crossing rather than exiting quietly and leaving you to assume you are out.

Three things it treats as first-class rather than afterthoughts:

- **Rearming.** After an alert it stays quiet until the price recovers past a band (`--rearm`,
  default 0.5%), so a price resting on the threshold does not alert every minute.
- **Going blind.** Five failed polls in a row raises its own alert, because a watcher that has
  lost its connection looks exactly like a calm market.
- **The floor on an automated exit.** `--exit-min-price` defaults to 20% under the threshold
  rather than to no floor at all. On a book with 157,000 XLM of bids inside 20% of the top, a
  floor that wide cannot block a real fill, so it does not defeat the purpose of a stop. What it
  does prevent is dumping the position into a book that has momentarily emptied out. Stellar
  rejects a zero `destMin` anyway, so "no floor" is not actually on the menu.

### exit.mjs

```bash
node exit.mjs --all --min-price 0.185          # preview
node exit.mjs --all --min-price 0.185 --send   # actually do it
```

Cancels the resting XLM offers and sells, as **one transaction**. That is the whole point: XLM
committed to a sell offer is locked, so cancelling and selling as two separate commands leaves a
window where the offer is gone and the sale has not happened. Stellar applies a transaction's
operations in order and all-or-nothing, so the cancel frees the XLM for the sale atomically.

The sale is a strict-send path payment rather than an offer, because when exiting you want a fill
rather than a queue position. `destMin` is a hard floor: if the book cannot beat it the entire
transaction fails and you still hold everything, which is the right outcome. Give the floor
explicitly with `--min-price`, or let `--slippage` derive it from the current book.

It sizes the sale against the reserve *after* the cancels land, since cancelling an offer frees a
subentry, and it refuses rather than guesses when the numbers do not work: a floor above the
market, a size beyond the balance, or `--send` with no TTY and no `--yes`.

Previews by default. Nothing is signed without `--send`.
