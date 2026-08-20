#!/usr/bin/env node
/**
 * Bridge native USDC between Solana (CCTP domain 5) and Stellar (domain 27) over
 * Circle's CCTP V2, in either direction. Burn on one chain, attest, mint on the other.
 *
 * Each side has a gotcha, and they are mirror images of each other:
 *
 * To Stellar: the 32-byte address encoding cannot tell an account from a contract, so
 * CCTP always reads mintRecipient as a contract. Minting straight to a G... account is
 * impossible. Instead mintRecipient and destinationCaller are both Circle's
 * CctpForwarder, and the real recipient rides along in hook data as a UTF-8 strkey.
 *
 * To Solana: mintRecipient is the recipient's USDC *token account*, never the wallet
 * address, and CCTP will not create it for you.
 *
 * Leaving Stellar also needs an approve first, because deposit_for_burn pulls the USDC
 * with transfer_from rather than taking it under your transaction's own authorization.
 *
 * Mainnet only. Run --dry-run first: it does every preflight check and simulates what
 * it can without sending anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair as SolanaKeypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import bs58 from 'bs58';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- env */

// Values already in the environment win over .env, so a one-off override works.
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

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const STELLAR_RPC = process.env.STELLAR_RPC_URL ?? 'https://mainnet.sorobanrpc.com';
const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const IRIS_API = process.env.IRIS_API_URL ?? 'https://iris-api.circle.com';

/* ---------------------------------------------------------------- constants */

const SOLANA_DOMAIN = 5;
const STELLAR_DOMAIN = 27;

// Solana mainnet, CCTP V2
const TOKEN_MESSENGER_MINTER = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe');
const MESSAGE_TRANSMITTER = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC');
const SOLANA_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Stellar mainnet, CCTP V2
const STELLAR_FORWARDER = 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T';
const STELLAR_TOKEN_MESSENGER_MINTER = 'CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL';
const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

const USDC_DECIMALS = 6; // what CCTP messages always carry; Stellar scales to 7 on arrival
const STELLAR_USDC_DECIMALS = 7;
const NO_DESTINATION_CALLER = Buffer.alloc(32); // all zeros means "any relayer may complete this"
const FINALITY_THRESHOLD_FINALIZED = 2000; // Stellar has no fast transfer, so always standard
const MIN_FEE_MULTIPLIER = 10_000_000n;
const RECLAIM_WINDOW_DAYS = 5;
const ALLOWANCE_TTL_LEDGERS = 17280; // roughly a day at 5s per ledger

const STATE_DIR = join(HERE, '.bridge');

/* ---------------------------------------------------------------- args */

const USAGE = `
bridge - move native USDC between Solana and Stellar over Circle CCTP V2 (mainnet)

usage: node bridge.mjs --amount <usdc> [options]
       node bridge.mjs --from stellar --amount <usdc>
       node bridge.mjs --resume <burn-tx-signature>
       node bridge.mjs --reclaim-all

  --amount <usdc>        amount to bridge, in USDC (e.g. 0.5)
  --from <chain>         solana (default) or stellar; sets the direction
  --to <address>         recipient on the far side. Going to Stellar, a G... or C...
                         (default STELLAR_RECIPIENT). Going to Solana, a wallet address
                         whose USDC token account already exists (default SOLANA_RECIPIENT,
                         else the SOLANA_SECRET_KEY wallet)
  --dry-run              run every preflight check and simulate the burn, send nothing
  --resume <sig>         a burn already landed: just attest and mint
  --mint-only            mint on Stellar from --message and --attestation hex
  --message <hex>        with --mint-only
  --attestation <hex>    with --mint-only
  --reclaim <sig>        close the Solana MessageSent account and refund its rent
                         (Solana burns only, and only ${RECLAIM_WINDOW_DAYS} days after)
  --reclaim-all          same, for every transfer in .bridge/ that is old enough
  --revoke-allowance     set the Stellar USDC allowance for CCTP back to zero
  --list                 show recorded transfers in .bridge/
  --yes                  skip the confirmation prompt
  --json                 emit JSON instead of prose
  -h, --help             this text

env (see .env.example): SOLANA_SECRET_KEY or SOLANA_KEYPAIR_FILE,
     STELLAR_SECRET_KEY or STELLAR_SECRET_KEY_FILE, STELLAR_RECIPIENT, SOLANA_RECIPIENT,
     SOLANA_RPC_URL, STELLAR_RPC_URL, HORIZON_URL, IRIS_API_URL,
     SOLANA_PRIORITY_FEE_MICROLAMPORTS, STELLAR_BASE_FEE
`.trim();

function parseArgs(argv) {
  const opts = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--amount': opts.amount = take(); break;
      case '--from': {
        opts.from = take().toLowerCase();
        if (opts.from !== 'solana' && opts.from !== 'stellar') throw new Error('--from must be solana or stellar');
        break;
      }
      case '--to': opts.to = take(); break;
      case '--resume': opts.resume = take(); break;
      case '--reclaim': opts.reclaim = take(); break;
      case '--message': opts.message = take(); break;
      case '--attestation': opts.attestation = take(); break;
      case '--dry-run': case '--mint-only': case '--list': case '--yes': case '--json': case '--reclaim-all':
      case '--revoke-allowance':
        opts.flags.add(arg.slice(2));
        break;
      case '-h': case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/* ---------------------------------------------------------------- small helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToBuf = (hex) => Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
const bufToHex = (buf) => `0x${Buffer.from(buf).toString('hex')}`;

// Parse a decimal string into integer subunits without ever touching a float.
function parseFixed(value, decimals) {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!m) throw new Error(`expected a positive decimal number, got: ${value}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`value has more than ${decimals} decimal places: ${value}`);
  return BigInt(m[1] + frac.padEnd(decimals, '0'));
}

// Same, for an amount the user asked to send, where zero is a mistake rather than a balance.
function toSubunits(value, decimals) {
  const subunits = parseFixed(value, decimals);
  if (subunits <= 0n) throw new Error('amount must be greater than zero');
  return subunits;
}

const fromSubunits = (subunits, decimals) => {
  const s = String(subunits).padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
};

const pda = (programId, seeds) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s instanceof PublicKey ? s.toBuffer() : s)),
    programId,
  )[0];

const associatedTokenAddress = (owner, mint) =>
  pda(ATA_PROGRAM, [owner, TOKEN_PROGRAM, mint]);

// Anchor's instruction discriminator.
const discriminator = (name) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

async function getJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${body.slice(0, 200)}`);
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function confirm(question, auto) {
  if (auto) return true;
  if (!process.stdin.isTTY) throw new Error('not a TTY: pass --yes to run unattended');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/* ---------------------------------------------------------------- keys */

function loadSolanaKeypair() {
  const fromArray = (arr) => SolanaKeypair.fromSecretKey(Uint8Array.from(arr));

  const file = process.env.SOLANA_KEYPAIR_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`SOLANA_KEYPAIR_FILE not found: ${file}`);
    return fromArray(JSON.parse(readFileSync(file, 'utf8')));
  }

  const secret = process.env.SOLANA_SECRET_KEY?.trim();
  if (!secret) throw new Error('set SOLANA_SECRET_KEY or SOLANA_KEYPAIR_FILE in .env');
  if (secret.startsWith('[')) return fromArray(JSON.parse(secret));
  return SolanaKeypair.fromSecretKey(bs58.decode(secret));
}

function loadStellarKeypair() {
  const file = process.env.STELLAR_SECRET_KEY_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`STELLAR_SECRET_KEY_FILE not found: ${file}`);
    const secret = readFileSync(file, 'utf8').trim();
    if (!secret) throw new Error(`STELLAR_SECRET_KEY_FILE is empty: ${file}`);
    return Keypair.fromSecret(secret);
  }
  const secret = process.env.STELLAR_SECRET_KEY?.trim();
  if (!secret) throw new Error('set STELLAR_SECRET_KEY or STELLAR_SECRET_KEY_FILE in .env');
  return Keypair.fromSecret(secret);
}

/* ---------------------------------------------------------------- CCTP encoding */

/**
 * Hook data the Stellar CctpForwarder reads to learn the real recipient.
 *   bytes  0-23  magic. zeros means "do not let Circle's forwarding service relay this",
 *                which is what we want since we submit the Stellar side ourselves.
 *   bytes 24-27  hook version, big-endian u32, must be 0
 *   bytes 28-31  strkey length, big-endian u32
 *   bytes 32+    recipient strkey, UTF-8, undecoded
 */
function buildHookData(recipientStrkey) {
  const recipient = Buffer.from(recipientStrkey, 'utf8');
  const hook = Buffer.alloc(32 + recipient.length);
  hook.writeUInt32BE(0, 24);
  hook.writeUInt32BE(recipient.length, 28);
  recipient.copy(hook, 32);
  return hook;
}

function encodeDepositForBurnWithHook({ amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold, hookData }) {
  const fixed = Buffer.alloc(8 + 4 + 32 + 32 + 8 + 4 + 4);
  let offset = 0;
  fixed.writeBigUInt64LE(amount, offset); offset += 8;
  fixed.writeUInt32LE(destinationDomain, offset); offset += 4;
  mintRecipient.toBuffer().copy(fixed, offset); offset += 32;
  destinationCaller.toBuffer().copy(fixed, offset); offset += 32;
  fixed.writeBigUInt64LE(maxFee, offset); offset += 8;
  fixed.writeUInt32LE(minFinalityThreshold, offset); offset += 4;
  fixed.writeUInt32LE(hookData.length, offset);
  return Buffer.concat([discriminator('deposit_for_burn_with_hook'), fixed, hookData]);
}

function decodeMessageHeader(message) {
  if (message.length < 148) throw new Error(`CCTP message is too short: ${message.length} bytes`);
  return {
    version: message.readUInt32BE(0),
    sourceDomain: message.readUInt32BE(4),
    destinationDomain: message.readUInt32BE(8),
    nonce: bufToHex(message.subarray(12, 44)),
    sender: bufToHex(message.subarray(44, 76)),
    recipient: bufToHex(message.subarray(76, 108)),
    destinationCaller: bufToHex(message.subarray(108, 140)),
    minFinalityThreshold: message.readUInt32BE(140),
    finalityThresholdExecuted: message.readUInt32BE(144),
  };
}

/* ---------------------------------------------------------------- solana accounts */

function depositForBurnAccounts({ owner, burnTokenAccount, messageSentEventData }) {
  return [
    { pubkey: owner, isSigner: true, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: true }, // event_rent_payer
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['sender_authority']), isSigner: false, isWritable: false },
    { pubkey: burnTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['denylist_account', owner]), isSigner: false, isWritable: false },
    { pubkey: pda(MESSAGE_TRANSMITTER, ['message_transmitter']), isSigner: false, isWritable: true },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['token_messenger']), isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['remote_token_messenger', String(STELLAR_DOMAIN)]), isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['token_minter']), isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['local_token', SOLANA_USDC]), isSigner: false, isWritable: true },
    { pubkey: SOLANA_USDC, isSigner: false, isWritable: true },
    { pubkey: messageSentEventData, isSigner: true, isWritable: true },
    { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // appended by Anchor's #[event_cpi]
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['__event_authority']), isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
  ];
}

/* ---------------------------------------------------------------- preflight */

async function preflight({ connection, solanaKeypair, stellarKeypair, recipient, amountSubunits }) {
  const notes = [];
  const forwarderRaw = Buffer.from(StrKey.decodeContract(STELLAR_FORWARDER));
  const forwarderKey = new PublicKey(forwarderRaw);

  // The route itself: Solana must know Stellar as domain 27, and the token messenger it
  // has registered there must be the very contract our mint step talks to.
  const remoteTokenMessengerKey = pda(TOKEN_MESSENGER_MINTER, ['remote_token_messenger', String(STELLAR_DOMAIN)]);
  const tokenMessengerKey = pda(TOKEN_MESSENGER_MINTER, ['token_messenger']);
  const burnTokenAccount = associatedTokenAddress(solanaKeypair.publicKey, SOLANA_USDC);

  const [remoteInfo, tokenMessengerInfo, burnTokenInfo] = await connection.getMultipleAccountsInfo([
    remoteTokenMessengerKey,
    tokenMessengerKey,
    burnTokenAccount,
  ]);

  if (!remoteInfo) throw new Error(`Solana CCTP has no remote token messenger for domain ${STELLAR_DOMAIN}`);
  const registeredDomain = remoteInfo.data.readUInt32LE(8);
  const registeredMessenger = Buffer.from(remoteInfo.data.subarray(12, 44));
  if (registeredDomain !== STELLAR_DOMAIN) {
    throw new Error(`remote token messenger reports domain ${registeredDomain}, expected ${STELLAR_DOMAIN}`);
  }
  const expectedMessenger = Buffer.from(StrKey.decodeContract(STELLAR_TOKEN_MESSENGER_MINTER));
  if (!registeredMessenger.equals(expectedMessenger)) {
    throw new Error(
      `Solana has ${bufToHex(registeredMessenger)} registered as the Stellar token messenger, ` +
        `but this script targets ${STELLAR_TOKEN_MESSENGER_MINTER} (${bufToHex(expectedMessenger)})`,
    );
  }

  if (!tokenMessengerInfo) throw new Error('Solana CCTP token messenger account not found');
  const minFee = BigInt(tokenMessengerInfo.data.readUInt32LE(173));
  const maxFee = minFee === 0n ? 0n : (amountSubunits * minFee) / MIN_FEE_MULTIPLIER || 1n;
  if (maxFee >= amountSubunits) throw new Error('CCTP minimum fee is not less than the amount being sent');
  if (maxFee > 0n) notes.push(`CCTP charges a protocol fee of ${fromSubunits(maxFee, USDC_DECIMALS)} USDC on this transfer`);

  // Funding on both ends.
  if (!burnTokenInfo) {
    throw new Error(`no USDC token account for ${solanaKeypair.publicKey.toBase58()} (expected ${burnTokenAccount.toBase58()})`);
  }
  const balance = BigInt((await connection.getTokenAccountBalance(burnTokenAccount)).value.amount);
  if (balance < amountSubunits) {
    throw new Error(
      `USDC balance is ${fromSubunits(balance, USDC_DECIMALS)}, need ${fromSubunits(amountSubunits, USDC_DECIMALS)}`,
    );
  }
  const lamports = await connection.getBalance(solanaKeypair.publicKey);
  if (lamports < 5_000_000) {
    notes.push(`Solana payer holds only ${(lamports / 1e9).toFixed(4)} SOL; the MessageSent account needs rent on top of fees`);
  }

  // The Stellar side: the account that submits mint_and_forward pays the fee in XLM.
  const relayer = await getJson(`${HORIZON}/accounts/${stellarKeypair.publicKey()}`);
  if (!relayer.ok) {
    throw new Error(`Stellar relayer ${stellarKeypair.publicKey()} is not funded on mainnet (Horizon ${relayer.status})`);
  }
  const xlm = Number(relayer.body.balances.find((b) => b.asset_type === 'native')?.balance ?? 0);
  if (xlm < 2) notes.push(`Stellar relayer holds ${xlm} XLM; keep a couple of XLM for Soroban resource fees`);

  // The recipient has to be able to hold classic USDC.
  if (StrKey.isValidEd25519PublicKey(recipient)) {
    const account = await getJson(`${HORIZON}/accounts/${recipient}`);
    if (!account.ok) throw new Error(`recipient ${recipient} does not exist on Stellar mainnet (Horizon ${account.status})`);
    const trustline = account.body.balances.find(
      (b) => b.asset_code === 'USDC' && b.asset_issuer === STELLAR_USDC_ISSUER,
    );
    if (!trustline) {
      throw new Error(`recipient ${recipient} has no USDC trustline (USDC:${STELLAR_USDC_ISSUER}); add it before bridging`);
    }
    const limit = Number(trustline.limit);
    const headroom = limit - Number(trustline.balance);
    if (headroom < Number(fromSubunits(amountSubunits, USDC_DECIMALS))) {
      throw new Error(`recipient's USDC trustline limit leaves only ${headroom} USDC of headroom`);
    }
  } else if (StrKey.isValidContract(recipient)) {
    notes.push(`recipient ${recipient} is a contract; make sure it can hold USDC`);
  } else {
    throw new Error(`recipient must be a Stellar G... account or C... contract, got: ${recipient}`);
  }

  return { forwarderKey, forwarderRaw, burnTokenAccount, maxFee, notes };
}

async function preflightReverse({ connection, solanaKeypair, stellarKeypair, recipient, amountStroops }) {
  const notes = [];
  const sender = stellarKeypair.publicKey();

  // Same route check as the other direction, read from the Solana side: the token pair for
  // domain 27 has to map Stellar USDC onto the Solana USDC local token.
  const remoteToken = Buffer.from(StrKey.decodeContract(STELLAR_USDC_SAC));
  const tokenPairKey = pda(TOKEN_MESSENGER_MINTER, ['token_pair', String(STELLAR_DOMAIN), remoteToken]);
  const localTokenKey = pda(TOKEN_MESSENGER_MINTER, ['local_token', SOLANA_USDC]);
  const [tokenPairInfo] = await connection.getMultipleAccountsInfo([tokenPairKey]);
  if (!tokenPairInfo) throw new Error(`Solana CCTP has no token pair for Stellar USDC on domain ${STELLAR_DOMAIN}`);
  if (tokenPairInfo.data.readUInt32LE(8) !== STELLAR_DOMAIN) throw new Error('token pair is registered against the wrong domain');
  if (!Buffer.from(tokenPairInfo.data.subarray(12, 44)).equals(remoteToken)) {
    throw new Error('token pair does not point at the Stellar USDC contract this script uses');
  }
  if (!new PublicKey(tokenPairInfo.data.subarray(44, 76)).equals(localTokenKey)) {
    throw new Error('token pair does not resolve to Solana USDC');
  }

  // On Solana the mint recipient is the TOKEN account, never the wallet. CCTP will not
  // create it, so it has to exist before we burn.
  let owner;
  try {
    owner = new PublicKey(recipient);
  } catch {
    throw new Error(`recipient must be a Solana address, got: ${recipient}`);
  }
  const recipientTokenAccount = associatedTokenAddress(owner, SOLANA_USDC);
  const tokenAccountInfo = await connection.getAccountInfo(recipientTokenAccount);
  if (!tokenAccountInfo) {
    throw new Error(
      `${owner.toBase58()} has no USDC token account (expected ${recipientTokenAccount.toBase58()}). ` +
        `Create it first: spl-token create-account ${SOLANA_USDC.toBase58()} --owner ${owner.toBase58()}`,
    );
  }
  if (!tokenAccountInfo.owner.equals(TOKEN_PROGRAM)) {
    throw new Error(`${recipientTokenAccount.toBase58()} is not an SPL token account`);
  }

  // Stellar side: contract limits and the sender's balance.
  const server = new rpc.Server(STELLAR_RPC);
  const readContract = (fn, ...args) =>
    readStellarContract(server, sender, STELLAR_TOKEN_MESSENGER_MINTER, fn, ...args);

  if (await readContract('paused')) throw new Error('Stellar CCTP TokenMessengerMinter is paused');
  const burnToken = new Address(STELLAR_USDC_SAC).toScVal();
  const maxPerMessage = BigInt(await readContract('get_max_burn_amount_per_message', burnToken));
  if (maxPerMessage > 0n && amountStroops > maxPerMessage) {
    throw new Error(
      `amount exceeds the per-message burn cap of ${fromSubunits(maxPerMessage, STELLAR_USDC_DECIMALS)} USDC`,
    );
  }
  const maxFeeStroops = BigInt(
    await readContract('get_min_fee_amount', burnToken, nativeToScVal(amountStroops, { type: 'i128' })),
  );
  if (maxFeeStroops >= amountStroops) throw new Error('CCTP minimum fee is not less than the amount being sent');
  if (maxFeeStroops > 0n) {
    notes.push(`CCTP charges a protocol fee of ${fromSubunits(maxFeeStroops, STELLAR_USDC_DECIMALS)} USDC on this transfer`);
  }

  const account = await getJson(`${HORIZON}/accounts/${sender}`);
  if (!account.ok) throw new Error(`Stellar sender ${sender} is not funded on mainnet (Horizon ${account.status})`);
  const usdc = account.body.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === STELLAR_USDC_ISSUER);
  if (!usdc) throw new Error(`sender ${sender} has no USDC trustline`);
  const held = parseFixed(usdc.balance, STELLAR_USDC_DECIMALS);
  if (held < amountStroops) {
    throw new Error(
      `USDC balance is ${fromSubunits(held, STELLAR_USDC_DECIMALS)}, need ${fromSubunits(amountStroops, STELLAR_USDC_DECIMALS)}`,
    );
  }
  const xlm = Number(account.body.balances.find((b) => b.asset_type === 'native')?.balance ?? 0);
  if (xlm < 2) notes.push(`sender holds ${xlm} XLM; keep a couple of XLM for Soroban resource fees`);

  // Solana relayer pays the receive fee plus permanent rent for the used-nonce account.
  const lamports = await connection.getBalance(solanaKeypair.publicKey);
  if (lamports < 5_000_000) {
    notes.push(`Solana relayer holds only ${(lamports / 1e9).toFixed(4)} SOL; it pays rent for the used-nonce account`);
  }

  // The mint step needs a lookup table to fit under Solana's transaction size limit. Say so
  // now, before anything is burned, rather than springing the cost at mint time.
  if (!(await lookupTableReady(connection))) {
    notes.push('a one-time Solana address lookup table gets created during the mint step (0.0046 SOL, recoverable)');
  }

  // deposit_for_burn pulls the USDC with transfer_from, so an allowance has to exist first.
  const allowance = await stellarAllowance(server, sender);
  const needsApproval = allowance < amountStroops;
  if (!needsApproval) {
    notes.push(`reusing an existing allowance of ${fromSubunits(allowance, STELLAR_USDC_DECIMALS)} USDC`);
  }

  return { server, recipientTokenAccount, maxFeeStroops, allowance, needsApproval, notes };
}

/* ---------------------------------------------------------------- step 1: burn */

async function burn({ connection, solanaKeypair, recipient, amountSubunits, forwarderKey, burnTokenAccount, maxFee, dryRun }) {
  const messageSentEventData = SolanaKeypair.generate();
  const hookData = buildHookData(recipient);

  const data = encodeDepositForBurnWithHook({
    amount: amountSubunits,
    destinationDomain: STELLAR_DOMAIN,
    mintRecipient: forwarderKey,
    destinationCaller: forwarderKey, // must equal mintRecipient or the funds strand
    maxFee,
    minFinalityThreshold: FINALITY_THRESHOLD_FINALIZED,
    hookData,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), // measured ~43k
    {
      programId: TOKEN_MESSENGER_MINTER,
      keys: depositForBurnAccounts({
        owner: solanaKeypair.publicKey,
        burnTokenAccount,
        messageSentEventData: messageSentEventData.publicKey,
      }),
      data,
    },
  ];
  const priorityFee = Number(process.env.SOLANA_PRIORITY_FEE_MICROLAMPORTS ?? 0);
  if (priorityFee > 0) {
    instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: solanaKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign([solanaKeypair, messageSentEventData]);

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join('\n  ');
    throw new Error(`burn simulation failed: ${JSON.stringify(sim.value.err)}\n  ${logs}`);
  }

  if (dryRun) {
    return {
      dryRun: true,
      unitsConsumed: sim.value.unitsConsumed,
      messageSentEventData: messageSentEventData.publicKey.toBase58(),
    };
  }

  const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`burn transaction ${signature} failed on chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return { signature, messageSentEventData: messageSentEventData.publicKey.toBase58() };
}

/* ---------------------------------------------------------------- step 2: attest */

async function fetchAttestation(signature, { sourceDomain = SOLANA_DOMAIN, timeoutMs = 30 * 60 * 1000, onWait } = {}) {
  const destinationDomain = sourceDomain === SOLANA_DOMAIN ? STELLAR_DOMAIN : SOLANA_DOMAIN;
  const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${signature}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const { status, ok, body } = await getJson(url);
    if (ok) {
      const messages = body?.messages ?? [];
      const bound = (m) => {
        try {
          return m.message && decodeMessageHeader(hexToBuf(m.message)).destinationDomain === destinationDomain;
        } catch {
          return false;
        }
      };
      const match = messages.find(bound) ?? messages[0];
      if (match) {
        if (match.status === 'complete' && match.attestation && match.attestation !== 'PENDING') {
          return { message: hexToBuf(match.message), attestation: hexToBuf(match.attestation), raw: match };
        }
        if (match.status !== lastStatus) {
          lastStatus = match.status;
          onWait?.(match.status);
        }
      }
    } else if (status !== 404) {
      throw new Error(`Iris returned ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    } else if (lastStatus !== 'not indexed') {
      lastStatus = 'not indexed';
      onWait?.('waiting for Iris to index the burn');
    }
    await sleep(5000);
  }
  throw new Error(`no attestation after ${Math.round(timeoutMs / 60000)} minutes; re-run with --resume ${signature}`);
}

/* ---------------------------------------------------------------- stellar plumbing */

function buildStellarTx(account, operation) {
  return new TransactionBuilder(account, {
    fee: process.env.STELLAR_BASE_FEE?.trim() || String(Number(BASE_FEE) * 100),
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
}

/** Read-only contract call: simulate and decode the return value, sending nothing. */
async function readStellarContract(server, sourceAddress, contractId, fn, ...args) {
  const account = await server.getAccount(sourceAddress);
  const tx = buildStellarTx(account, new Contract(contractId).call(fn, ...args));
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} failed: ${sim.error}`);
  return scValToNative(sim.result.retval);
}

/** Simulate, sign, send and wait. Nothing reaches the network if the simulation fails. */
async function submitStellar(server, keypair, operation, { label, dryRun }) {
  const account = await server.getAccount(keypair.publicKey());
  const tx = buildStellarTx(account, operation);

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${label} simulation failed: ${sim.error}`);

  const prepared = rpc.assembleTransaction(tx, sim).build();
  if (dryRun) return { dryRun: true, feeStroops: Number(prepared.fee) };

  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`Stellar rejected ${label}: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'NOT_FOUND') continue;
    if (got.status !== 'SUCCESS') {
      throw new Error(`Stellar ${label} ${sent.hash} failed: ${JSON.stringify(got.resultXdr ?? got)}`);
    }
    return { hash: sent.hash, feeStroops: Number(prepared.fee) };
  }
  throw new Error(`Stellar ${label} ${sent.hash} not confirmed in 90s; check it before retrying`);
}

/* ---------------------------------------------------------------- step 3: mint */

async function mintOnStellar({ stellarKeypair, message, attestation, forwarderRaw }) {
  const header = decodeMessageHeader(message);
  if (header.sourceDomain !== SOLANA_DOMAIN) {
    throw new Error(`message source domain is ${header.sourceDomain}, expected ${SOLANA_DOMAIN}`);
  }
  if (header.destinationDomain !== STELLAR_DOMAIN) {
    throw new Error(`message destination domain is ${header.destinationDomain}, expected ${STELLAR_DOMAIN}`);
  }
  const expectedCaller = bufToHex(forwarderRaw);
  if (header.destinationCaller !== expectedCaller) {
    throw new Error(
      `message destinationCaller is ${header.destinationCaller}, but only ${STELLAR_FORWARDER} ` +
        `(${expectedCaller}) can complete a forwarded transfer`,
    );
  }

  const server = new rpc.Server(STELLAR_RPC);
  const operation = new Contract(STELLAR_FORWARDER).call(
    'mint_and_forward',
    xdr.ScVal.scvBytes(message),
    xdr.ScVal.scvBytes(attestation),
  );
  return submitStellar(server, stellarKeypair, operation, { label: 'mint_and_forward' });
}

/* ------------------------------------------------- stellar to solana: burn on Stellar */

/**
 * Stellar USDC has 7 decimals and CCTP messages carry 6, so the contract drops the 7th
 * digit before burning and leaves it in your account. We round here too, so the amount
 * shown in the confirmation is the amount that actually moves.
 */
function normalizeStellarAmount(stroops) {
  const scale = 10n ** BigInt(STELLAR_USDC_DECIMALS - USDC_DECIMALS);
  const dust = stroops % scale;
  return { burned: stroops - dust, dust };
}

/**
 * The Stellar TokenMessengerMinter pulls your USDC with transfer_from, so it needs a
 * standing allowance first. Circle's own source says so:
 *   "Uses transfer_from which requires the caller to have previously approved this
 *    contract to spend tokens on their behalf via token.approve()."
 * We approve exactly the burn amount, so deposit_for_burn consumes it back to zero.
 */
async function stellarAllowance(server, owner) {
  return BigInt(
    await readStellarContract(
      server,
      owner,
      STELLAR_USDC_SAC,
      'allowance',
      new Address(owner).toScVal(),
      new Address(STELLAR_TOKEN_MESSENGER_MINTER).toScVal(),
    ),
  );
}

async function approveOnStellar({ server, stellarKeypair, amountStroops, dryRun }) {
  const { sequence } = await server.getLatestLedger();
  const expirationLedger = sequence + ALLOWANCE_TTL_LEDGERS;
  const operation = new Contract(STELLAR_USDC_SAC).call(
    'approve',
    new Address(stellarKeypair.publicKey()).toScVal(),
    new Address(STELLAR_TOKEN_MESSENGER_MINTER).toScVal(),
    nativeToScVal(amountStroops, { type: 'i128' }),
    xdr.ScVal.scvU32(expirationLedger),
  );
  const result = await submitStellar(server, stellarKeypair, operation, { label: 'approve', dryRun });
  return { ...result, expirationLedger };
}

async function burnOnStellar({ server, stellarKeypair, amountStroops, mintRecipient, maxFeeStroops, dryRun }) {
  const operation = new Contract(STELLAR_TOKEN_MESSENGER_MINTER).call(
    'deposit_for_burn',
    new Address(stellarKeypair.publicKey()).toScVal(), // caller
    nativeToScVal(amountStroops, { type: 'i128' }), // amount, in 7-decimal stroops
    xdr.ScVal.scvU32(SOLANA_DOMAIN), // destination_domain
    xdr.ScVal.scvBytes(mintRecipient.toBuffer()), // mint_recipient: the Solana TOKEN account
    new Address(STELLAR_USDC_SAC).toScVal(), // burn_token
    xdr.ScVal.scvBytes(NO_DESTINATION_CALLER), // destination_caller
    nativeToScVal(maxFeeStroops, { type: 'i128' }), // max_fee
    xdr.ScVal.scvU32(FINALITY_THRESHOLD_FINALIZED),
  );
  const result = await submitStellar(server, stellarKeypair, operation, { label: 'deposit_for_burn', dryRun });
  return { ...result, signature: result.hash };
}

/* ------------------------------------------------- stellar to solana: mint on Solana */

/**
 * receive_message validates the attestation, then CPIs into the TokenMessengerMinter to
 * mint. The minter's accounts ride along as remaining accounts, in this exact order.
 */
function receiveMessageAccounts({ payer, recipientTokenAccount, feeRecipientTokenAccount, nonce }) {
  const remoteToken = Buffer.from(StrKey.decodeContract(STELLAR_USDC_SAC));
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: false }, // caller
    { pubkey: pda(MESSAGE_TRANSMITTER, ['message_transmitter_authority', TOKEN_MESSENGER_MINTER]), isSigner: false, isWritable: false },
    { pubkey: pda(MESSAGE_TRANSMITTER, ['message_transmitter']), isSigner: false, isWritable: false },
    { pubkey: pda(MESSAGE_TRANSMITTER, ['used_nonce', nonce]), isSigner: false, isWritable: true },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false }, // receiver
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: pda(MESSAGE_TRANSMITTER, ['__event_authority']), isSigner: false, isWritable: false },
    { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
    // remaining accounts, forwarded verbatim to the TokenMessengerMinter
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['token_messenger']), isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['remote_token_messenger', String(STELLAR_DOMAIN)]), isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['token_minter']), isSigner: false, isWritable: true },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['local_token', SOLANA_USDC]), isSigner: false, isWritable: true },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['token_pair', String(STELLAR_DOMAIN), remoteToken]), isSigner: false, isWritable: false },
    { pubkey: feeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['custody', SOLANA_USDC]), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: pda(TOKEN_MESSENGER_MINTER, ['__event_authority']), isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
  ];
}

/**
 * A Stellar-origin message is 376 bytes and its attestation 130, which pushes a plain
 * receive_message transaction to ~1266 bytes against Solana's 1232-byte limit. An address
 * lookup table replaces each 32-byte account key with a 1-byte index and brings it back
 * under. The table is created once, cached in .bridge/, and reused by every transfer.
 */
function lookupTableAddresses() {
  const remoteToken = Buffer.from(StrKey.decodeContract(STELLAR_USDC_SAC));
  return [
    pda(MESSAGE_TRANSMITTER, ['message_transmitter_authority', TOKEN_MESSENGER_MINTER]),
    pda(MESSAGE_TRANSMITTER, ['message_transmitter']),
    pda(MESSAGE_TRANSMITTER, ['__event_authority']),
    MESSAGE_TRANSMITTER,
    TOKEN_MESSENGER_MINTER,
    SystemProgram.programId,
    pda(TOKEN_MESSENGER_MINTER, ['token_messenger']),
    pda(TOKEN_MESSENGER_MINTER, ['remote_token_messenger', String(STELLAR_DOMAIN)]),
    pda(TOKEN_MESSENGER_MINTER, ['token_minter']),
    pda(TOKEN_MESSENGER_MINTER, ['local_token', SOLANA_USDC]),
    pda(TOKEN_MESSENGER_MINTER, ['token_pair', String(STELLAR_DOMAIN), remoteToken]),
    pda(TOKEN_MESSENGER_MINTER, ['custody', SOLANA_USDC]),
    pda(TOKEN_MESSENGER_MINTER, ['__event_authority']),
    TOKEN_PROGRAM,
    ComputeBudgetProgram.programId,
  ];
}

const LUT_PATH = () => join(STATE_DIR, 'lookup-table.json');

function lookupTableCovers(account) {
  const have = new Set(account.state.addresses.map((a) => a.toBase58()));
  return lookupTableAddresses().every((a) => have.has(a.toBase58()));
}

/** Is a usable table already cached? Read-only, safe to call from preflight. */
async function lookupTableReady(connection) {
  if (!existsSync(LUT_PATH())) return false;
  const { address } = JSON.parse(readFileSync(LUT_PATH(), 'utf8'));
  const found = (await connection.getAddressLookupTable(new PublicKey(address))).value;
  return Boolean(found && lookupTableCovers(found));
}

async function ensureLookupTable({ connection, solanaKeypair, emit }) {
  const wanted = lookupTableAddresses();
  const covers = lookupTableCovers;

  if (existsSync(LUT_PATH())) {
    const { address } = JSON.parse(readFileSync(LUT_PATH(), 'utf8'));
    const found = (await connection.getAddressLookupTable(new PublicKey(address))).value;
    if (found && covers(found)) return found;
    emit?.('cached lookup table is missing or incomplete, building a new one');
  }

  emit?.('creating a Solana address lookup table (one time, a few cents of rent)');
  const recentSlot = await connection.getSlot('finalized');
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: solanaKeypair.publicKey,
    payer: solanaKeypair.publicKey,
    recentSlot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: solanaKeypair.publicKey,
    authority: solanaKeypair.publicKey,
    lookupTable: address,
    addresses: wanted,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: solanaKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx, extendIx],
    }).compileToV0Message(),
  );
  tx.sign([solanaKeypair]);
  const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`lookup table setup failed: ${JSON.stringify(confirmation.value.err)}`);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LUT_PATH(), `${JSON.stringify({ address: address.toBase58(), createdAt: new Date().toISOString() }, null, 2)}\n`);
  emit?.(`  lookup table ${address.toBase58()}`);

  // A table cannot be used in the slot it was extended in, so wait for the next one.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const found = (await connection.getAddressLookupTable(address)).value;
    if (found && covers(found) && (await connection.getSlot('confirmed')) > recentSlot + 1) return found;
  }
  throw new Error(`lookup table ${address.toBase58()} did not become usable; re-run to retry`);
}

function encodeReceiveMessage(message, attestation) {
  const body = Buffer.alloc(4 + message.length + 4 + attestation.length);
  body.writeUInt32LE(message.length, 0);
  message.copy(body, 4);
  body.writeUInt32LE(attestation.length, 4 + message.length);
  attestation.copy(body, 8 + message.length);
  return Buffer.concat([discriminator('receive_message'), body]);
}

async function feeRecipientTokenAccountFor(connection) {
  const info = await connection.getAccountInfo(pda(TOKEN_MESSENGER_MINTER, ['token_messenger']));
  if (!info) throw new Error('Solana CCTP token messenger account not found');
  return associatedTokenAddress(new PublicKey(info.data.subarray(109, 141)), SOLANA_USDC);
}

async function receiveOnSolana({ connection, solanaKeypair, message, attestation, recipientTokenAccount, lookupTable, simulateOnly }) {
  const header = decodeMessageHeader(message);
  if (header.sourceDomain !== STELLAR_DOMAIN) {
    throw new Error(`message source domain is ${header.sourceDomain}, expected ${STELLAR_DOMAIN}`);
  }
  if (header.destinationDomain !== SOLANA_DOMAIN) {
    throw new Error(`message destination domain is ${header.destinationDomain}, expected ${SOLANA_DOMAIN}`);
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    {
      programId: MESSAGE_TRANSMITTER,
      keys: receiveMessageAccounts({
        payer: solanaKeypair.publicKey,
        recipientTokenAccount,
        feeRecipientTokenAccount: await feeRecipientTokenAccountFor(connection),
        nonce: message.subarray(12, 44),
      }),
      data: encodeReceiveMessage(message, attestation),
    },
  ];
  const priorityFee = Number(process.env.SOLANA_PRIORITY_FEE_MICROLAMPORTS ?? 0);
  if (priorityFee > 0) {
    instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: solanaKeypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(
      lookupTable ? [lookupTable] : [],
    ),
  );
  tx.sign([solanaKeypair]);

  const size = tx.serialize().length;
  if (size > 1232) throw new Error(`receive transaction is ${size} bytes, over Solana's 1232-byte limit`);

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (simulateOnly) return { simulation: sim.value, size };
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join('\n  ');
    throw new Error(`receive_message simulation failed: ${JSON.stringify(sim.value.err)}\n  ${logs}`);
  }

  const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`receive_message ${signature} failed on chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return { signature, unitsConsumed: sim.value.unitsConsumed, size };
}

/* ---------------------------------------------------------------- reclaim */

/**
 * What can be done with one transfer's MessageSent account right now. The rent is a
 * deposit, not a fee, and comes back in full to whoever paid it.
 */
async function inspectEventAccount(connection, record) {
  if (record.direction === 'stellar-to-solana') {
    return { eligible: false, reason: 'burned on Stellar, no Solana rent to reclaim' };
  }
  if (!record.messageSentEventData) return { eligible: false, reason: 'no MessageSent account recorded' };
  if (!record.message || !record.attestation) {
    return { eligible: false, reason: `not attested yet, run --resume ${record.signature} first` };
  }

  const eventAccount = new PublicKey(record.messageSentEventData);
  const info = await connection.getAccountInfo(eventAccount);
  if (!info) return { eligible: false, closed: true, reason: 'already closed' };

  // MessageSent: 8 discriminator, 32 rent_payer, 8 created_at, then the message vector.
  const createdAt = Number(info.data.readBigInt64LE(40));
  const unlockAt = createdAt + RECLAIM_WINDOW_DAYS * 86400;
  const now = Math.floor(Date.now() / 1000);
  if (now < unlockAt) {
    const hours = (unlockAt - now) / 3600;
    return {
      eligible: false,
      lamports: info.lamports,
      unlockAt,
      reason: `${hours.toFixed(1)}h to go, opens ${new Date(unlockAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}Z`,
    };
  }
  return { eligible: true, eventAccount, lamports: info.lamports, unlockAt };
}

async function reclaimEventAccount({ connection, solanaKeypair, record, state }) {
  const checked = state ?? (await inspectEventAccount(connection, record));
  if (!checked.eligible) {
    if (checked.closed) return { alreadyClosed: true, eventAccount: record.messageSentEventData };
    throw new Error(checked.reason);
  }
  const { eventAccount, lamports } = checked;

  const message = hexToBuf(record.message);
  const attestation = hexToBuf(record.attestation);
  const params = Buffer.alloc(4 + attestation.length + 4 + message.length);
  params.writeUInt32LE(attestation.length, 0);
  attestation.copy(params, 4);
  params.writeUInt32LE(message.length, 4 + attestation.length);
  message.copy(params, 8 + attestation.length);

  const instruction = {
    programId: MESSAGE_TRANSMITTER,
    keys: [
      { pubkey: solanaKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda(MESSAGE_TRANSMITTER, ['message_transmitter']), isSigner: false, isWritable: true },
      { pubkey: eventAccount, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator('reclaim_event_account'), params]),
  };

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: solanaKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message(),
  );
  tx.sign([solanaKeypair]);

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join('\n  ');
    const hint = logs.includes('EventAccountWindowNotExpired')
      ? `\n  the MessageSent account can only be closed ${RECLAIM_WINDOW_DAYS} days after the burn`
      : '';
    throw new Error(`reclaim simulation failed: ${JSON.stringify(sim.value.err)}${hint}\n  ${logs}`);
  }

  const signature = await connection.sendTransaction(tx, { maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`reclaim failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, eventAccount: record.messageSentEventData, lamports };
}

/**
 * Sweep every recorded transfer. One transaction each: a reclaim instruction carries the
 * whole message plus attestation, so two of them do not fit in Solana's 1232-byte limit.
 */
async function reclaimAll({ connection, solanaKeypair }) {
  const results = [];
  for (const record of listRecords()) {
    const state = await inspectEventAccount(connection, record);
    if (!state.eligible) {
      if (state.closed) saveRecord(record.signature, { eventAccountClosed: true });
      results.push({ signature: record.signature, lamports: state.lamports, skipped: state.reason });
      continue;
    }
    try {
      const done = await reclaimEventAccount({ connection, solanaKeypair, record, state });
      saveRecord(record.signature, { reclaimSignature: done.signature, eventAccountClosed: true });
      results.push({ signature: record.signature, lamports: done.lamports, reclaimed: done.signature });
    } catch (e) {
      // One stuck account should not strand the rest of the sweep.
      results.push({ signature: record.signature, lamports: state.lamports, error: e.message });
    }
  }
  return results;
}

/* ---------------------------------------------------------------- transfer records */

function recordPath(signature) {
  return join(STATE_DIR, `${signature}.json`);
}

function saveRecord(signature, patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = recordPath(signature);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const record = { ...existing, ...patch, signature, updatedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function loadRecord(signature) {
  const path = recordPath(signature);
  if (!existsSync(path)) return { signature };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listRecords() {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')))
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
}

/* ---------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const json = opts.flags.has('json');
  const emit = (...parts) => {
    if (!json) console.log(...parts);
  };

  if (opts.flags.has('list')) {
    const records = listRecords();
    if (json) return console.log(JSON.stringify(records, null, 2));
    if (!records.length) return console.log('no transfers recorded in .bridge/');
    for (const r of records) {
      const arrow = r.direction === 'stellar-to-solana' ? 'XLM->SOL' : 'SOL->XLM';
      const state = (r.mintHash ?? r.stellarHash) ? 'minted' : r.message ? 'attested, not minted' : 'burned';
      console.log(`${r.signature}  ${arrow}  ${r.amount ?? '?'} USDC -> ${r.recipient ?? '?'}  ${state}`);
    }
    return;
  }

  // Catch a fat-fingered amount before we go looking for keys.
  const amountSubunits = opts.amount === undefined ? undefined : toSubunits(opts.amount, USDC_DECIMALS);

  const connection = new Connection(SOLANA_RPC, 'confirmed');

  if (opts.flags.has('revoke-allowance')) {
    const stellarKeypair = loadStellarKeypair();
    const server = new rpc.Server(STELLAR_RPC);
    const current = await stellarAllowance(server, stellarKeypair.publicKey());
    if (current === 0n) return console.log('the CCTP allowance is already zero, nothing to revoke');
    const revoked = await approveOnStellar({ server, stellarKeypair, amountStroops: 0n });
    if (json) return console.log(JSON.stringify(revoked, null, 2));
    return console.log(
      `revoked an allowance of ${fromSubunits(current, STELLAR_USDC_DECIMALS)} USDC\n` +
        `  https://stellar.expert/explorer/public/tx/${revoked.hash}`,
    );
  }

  if (opts.flags.has('reclaim-all')) {
    const solanaKeypair = loadSolanaKeypair();
    const results = await reclaimAll({ connection, solanaKeypair });
    if (json) return console.log(JSON.stringify(results, null, 2));
    if (!results.length) return console.log('no transfers recorded in .bridge/');

    const recovered = results.filter((r) => r.reclaimed);
    const lamports = recovered.reduce((sum, r) => sum + (r.lamports ?? 0), 0);
    for (const r of results) {
      const short = `${r.signature.slice(0, 8)}..${r.signature.slice(-6)}`;
      if (r.reclaimed) console.log(`  ${short}  reclaimed ${(r.lamports / 1e9).toFixed(6)} SOL  https://solscan.io/tx/${r.reclaimed}`);
      else if (r.error) console.log(`  ${short}  failed: ${r.error.split('\n')[0]}`);
      else console.log(`  ${short}  skipped: ${r.skipped}`);
    }
    const waiting = results.filter((r) => r.skipped && r.lamports);
    if (waiting.length) {
      const held = waiting.reduce((sum, r) => sum + r.lamports, 0);
      console.log(`\n${waiting.length} still inside the ${RECLAIM_WINDOW_DAYS}-day window, holding ${(held / 1e9).toFixed(6)} SOL`);
    }
    return console.log(
      recovered.length
        ? `\nrecovered ${(lamports / 1e9).toFixed(6)} SOL from ${recovered.length} account${recovered.length > 1 ? 's' : ''}`
        : '\nnothing to reclaim yet',
    );
  }

  if (opts.reclaim) {
    const solanaKeypair = loadSolanaKeypair();
    const record = loadRecord(opts.reclaim);
    const result = await reclaimEventAccount({ connection, solanaKeypair, record });
    if (json) return console.log(JSON.stringify(result, null, 2));
    if (result.alreadyClosed) return console.log(`MessageSent account ${result.eventAccount} is already closed`);
    saveRecord(opts.reclaim, { reclaimSignature: result.signature });
    return console.log(`reclaimed rent from ${result.eventAccount}\n  https://solscan.io/tx/${result.signature}`);
  }

  const forwarderRaw = Buffer.from(StrKey.decodeContract(STELLAR_FORWARDER));

  // Mint only: we already hold an attested message.
  if (opts.flags.has('mint-only')) {
    if (!opts.message || !opts.attestation) throw new Error('--mint-only needs --message and --attestation');
    const stellarKeypair = loadStellarKeypair();
    const minted = await mintOnStellar({
      stellarKeypair,
      message: hexToBuf(opts.message),
      attestation: hexToBuf(opts.attestation),
      forwarderRaw,
    });
    if (json) return console.log(JSON.stringify(minted, null, 2));
    return console.log(`minted on Stellar\n  https://stellar.expert/explorer/public/tx/${minted.hash}`);
  }

  const stellarKeypair = loadStellarKeypair();
  let signature = opts.resume;
  let record = signature ? loadRecord(signature) : {};
  const direction = record.direction ?? (opts.from === 'stellar' ? 'stellar-to-solana' : 'solana-to-stellar');
  const toStellar = direction === 'solana-to-stellar';
  const sourceDomain = toStellar ? SOLANA_DOMAIN : STELLAR_DOMAIN;

  let recipient =
    opts.to ??
    record.recipient ??
    (toStellar
      ? process.env.STELLAR_RECIPIENT?.trim()
      : process.env.SOLANA_RECIPIENT?.trim() || loadSolanaKeypair().publicKey.toBase58());
  if (!recipient) {
    throw new Error(`no recipient: pass --to or set ${toStellar ? 'STELLAR_RECIPIENT' : 'SOLANA_RECIPIENT'} in .env`);
  }

  // Step 1, unless we are resuming a burn that already landed.
  if (!signature) {
    if (amountSubunits === undefined) throw new Error('--amount is required (e.g. --amount 0.5)');
    const solanaKeypair = loadSolanaKeypair();
    const dryRun = opts.flags.has('dry-run');

    if (toStellar) {
      const checks = await preflight({ connection, solanaKeypair, stellarKeypair, recipient, amountSubunits });

      if (!json) {
        console.log('');
        console.log(`  send        ${fromSubunits(amountSubunits, USDC_DECIMALS)} USDC`);
        console.log(`  from        ${solanaKeypair.publicKey.toBase58()} (Solana, domain ${SOLANA_DOMAIN})`);
        console.log(`  to          ${recipient} (Stellar, domain ${STELLAR_DOMAIN})`);
        console.log(`  via         ${STELLAR_FORWARDER}`);
        console.log(`              mintRecipient = destinationCaller = ${bufToHex(checks.forwarderRaw)}`);
        console.log(`  protocol    standard transfer, maxFee ${fromSubunits(checks.maxFee, USDC_DECIMALS)} USDC, finality ${FINALITY_THRESHOLD_FINALIZED}`);
        console.log(`  relayed by  ${stellarKeypair.publicKey()} (pays the Stellar fee)`);
        for (const note of checks.notes) console.log(`  note        ${note}`);
        console.log('');
      }

      if (!dryRun && !(await confirm('Burn this USDC on Solana?', opts.flags.has('yes')))) {
        return console.log('aborted, nothing sent');
      }

      const burned = await burn({
        connection,
        solanaKeypair,
        recipient,
        amountSubunits,
        forwarderKey: checks.forwarderKey,
        burnTokenAccount: checks.burnTokenAccount,
        maxFee: checks.maxFee,
        dryRun,
      });

      if (dryRun) {
        const out = { dryRun: true, ok: true, ...burned, direction, recipient, amount: fromSubunits(amountSubunits, USDC_DECIMALS) };
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`dry run OK: burn simulated cleanly (${burned.unitsConsumed} compute units), nothing was sent`);
      }

      signature = burned.signature;
      record = saveRecord(signature, {
        direction,
        amount: fromSubunits(amountSubunits, USDC_DECIMALS),
        recipient,
        source: solanaKeypair.publicKey.toBase58(),
        messageSentEventData: burned.messageSentEventData,
        burnedAt: new Date().toISOString(),
      });
      emit(`burned on Solana\n  https://solscan.io/tx/${signature}`);
    } else {
      // Stellar USDC carries a 7th decimal that CCTP messages cannot express.
      const requested = toSubunits(opts.amount, STELLAR_USDC_DECIMALS);
      const { burned: amountStroops, dust } = normalizeStellarAmount(requested);
      if (amountStroops <= 0n) throw new Error('amount is smaller than one CCTP subunit (0.000001 USDC)');

      const checks = await preflightReverse({ connection, solanaKeypair, stellarKeypair, recipient, amountStroops });

      if (!json) {
        console.log('');
        console.log(`  send        ${fromSubunits(amountStroops, STELLAR_USDC_DECIMALS)} USDC`);
        console.log(`  from        ${stellarKeypair.publicKey()} (Stellar, domain ${STELLAR_DOMAIN})`);
        console.log(`  to          ${recipient} (Solana, domain ${SOLANA_DOMAIN})`);
        console.log(`              mintRecipient = ${checks.recipientTokenAccount.toBase58()} (its USDC token account)`);
        console.log(`  protocol    standard transfer, maxFee ${fromSubunits(checks.maxFeeStroops, STELLAR_USDC_DECIMALS)} USDC, finality ${FINALITY_THRESHOLD_FINALIZED}`);
        console.log(`  relayed by  ${solanaKeypair.publicKey.toBase58()} (pays the Solana fee and nonce rent)`);
        if (checks.needsApproval) console.log(`  approve     yes, a separate Stellar transaction (deposit_for_burn pulls with transfer_from)`);
        if (dust > 0n) console.log(`  note        ${fromSubunits(dust, STELLAR_USDC_DECIMALS)} USDC of dust stays on Stellar, CCTP cannot carry the 7th decimal`);
        for (const note of checks.notes) console.log(`  note        ${note}`);
        console.log('');
      }

      if (!dryRun && !(await confirm('Approve and burn this USDC on Stellar?', opts.flags.has('yes')))) {
        return console.log('aborted, nothing sent');
      }

      // Two Stellar transactions: Soroban allows only one contract call per transaction.
      if (checks.needsApproval) {
        const approved = await approveOnStellar({
          server: checks.server,
          stellarKeypair,
          amountStroops,
          dryRun,
        });
        if (dryRun) {
          const out = { dryRun: true, ok: true, direction, recipient, approveFeeStroops: approved.feeStroops };
          if (json) return console.log(JSON.stringify(out, null, 2));
          console.log(`dry run OK: approve simulated cleanly (fee ${approved.feeStroops / 1e7} XLM), nothing was sent`);
          return console.log('  the burn cannot be simulated until the allowance exists on chain');
        }
        emit(`approved ${fromSubunits(amountStroops, STELLAR_USDC_DECIMALS)} USDC to the CCTP TokenMessengerMinter`);
        emit(`  https://stellar.expert/explorer/public/tx/${approved.hash}`);
      }

      const burned = await burnOnStellar({
        server: checks.server,
        stellarKeypair,
        amountStroops,
        mintRecipient: checks.recipientTokenAccount,
        maxFeeStroops: checks.maxFeeStroops,
        dryRun,
      });

      if (dryRun) {
        const out = { dryRun: true, ok: true, direction, recipient, amount: fromSubunits(amountStroops, STELLAR_USDC_DECIMALS), ...burned };
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`dry run OK: burn simulated cleanly (fee ${burned.feeStroops / 1e7} XLM), nothing was sent`);
      }

      signature = burned.signature;
      record = saveRecord(signature, {
        direction,
        amount: fromSubunits(amountStroops, STELLAR_USDC_DECIMALS),
        recipient,
        source: stellarKeypair.publicKey(),
        recipientTokenAccount: checks.recipientTokenAccount.toBase58(),
        burnedAt: new Date().toISOString(),
      });
      emit(`burned on Stellar\n  https://stellar.expert/explorer/public/tx/${signature}`);
    }
    emit(`  recorded in .bridge/${signature}.json (resume with --resume ${signature})`);
  }

  // Step 2.
  let message;
  let attestation;
  if (record.message && record.attestation) {
    message = hexToBuf(record.message);
    attestation = hexToBuf(record.attestation);
    emit('using the attestation already recorded for this burn');
  } else {
    emit('waiting for Circle to attest the burn (standard transfers finalize in a few minutes)');
    const attested = await fetchAttestation(signature, { sourceDomain, onWait: (s) => emit(`  ${s}`) });
    message = attested.message;
    attestation = attested.attestation;
    record = saveRecord(signature, { message: bufToHex(message), attestation: bufToHex(attestation) });
    emit('attested');
  }

  if (record.mintHash) {
    emit(`already minted: ${record.mintHash}`);
    if (json) console.log(JSON.stringify(record, null, 2));
    return;
  }

  // Step 3.
  if (toStellar) {
    const minted = await mintOnStellar({ stellarKeypair, message, attestation, forwarderRaw });
    record = saveRecord(signature, { mintHash: minted.hash, stellarHash: minted.hash, mintedAt: new Date().toISOString() });
    if (json) return console.log(JSON.stringify(record, null, 2));
    console.log(`minted on Stellar\n  https://stellar.expert/explorer/public/tx/${minted.hash}`);
    console.log(`${record.amount} USDC delivered to ${recipient}`);
    console.log(`rent on the Solana MessageSent account can be reclaimed in ${RECLAIM_WINDOW_DAYS} days: node bridge.mjs --reclaim-all`);
    return;
  }

  const solanaKeypair = loadSolanaKeypair();
  const recipientTokenAccount = record.recipientTokenAccount
    ? new PublicKey(record.recipientTokenAccount)
    : associatedTokenAddress(new PublicKey(recipient), SOLANA_USDC);
  const lookupTable = await ensureLookupTable({ connection, solanaKeypair, emit });
  const minted = await receiveOnSolana({ connection, solanaKeypair, message, attestation, recipientTokenAccount, lookupTable });
  record = saveRecord(signature, { mintHash: minted.signature, mintedAt: new Date().toISOString() });

  if (json) return console.log(JSON.stringify(record, null, 2));
  console.log(`minted on Solana\n  https://solscan.io/tx/${minted.signature}`);
  console.log(`${record.amount} USDC delivered to ${recipientTokenAccount.toBase58()}`);
}

// Guarded so the encoding helpers above can be imported and exercised on their own.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`bridge: ${e.message}`);
    process.exit(1);
  });
}

export {
  associatedTokenAddress,
  encodeReceiveMessage,
  feeRecipientTokenAccountFor,
  lookupTableAddresses,
  receiveMessageAccounts,
  buildHookData,
  decodeMessageHeader,
  depositForBurnAccounts,
  encodeDepositForBurnWithHook,
  toSubunits,
};
