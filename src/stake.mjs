// On-chain logic for the shdwDrive v2 operator staking program.
// All instruction layouts were taken from real Unstake / Withdraw transactions
// of this program and verified by simulation on mainnet.

import {
  Connection, PublicKey, Keypair, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";

// Program and shared accounts (same for every operator)
const PROGRAM    = new PublicKey("BsbBGrUe9SiGYPUVDvmLb9ppfkJc4esMKdacpepc3T23");
const CONFIG     = new PublicKey("G6mxc1cFq2HQwGzowiWbSkVeKa2HhwVXkbrQwZrAXkpd");
const VAULT      = new PublicKey("8gV1fx8WJQLXKDpPsVsQGbuvrsjvwk1qHw3mck2JSzND");
const VAULT_AUTH = new PublicKey("BLaVn97iN5cU3L7qK1d3fvig9oisDC1TfumQfPRJB8cR");
const MINT       = new PublicKey("SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y");
const TOKEN      = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROG   = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Anchor discriminators (first 8 bytes of sha256("global:<name>"))
const IX_UNSTAKE  = Buffer.from("bc5e736dcc5d8cb300", "hex"); // unstake_node + 1 byte arg
const IX_WITHDRAW = Buffer.from("606c5d878cb4f9e9", "hex");   // withdraw_unstaked_tokens

// Stake record layout: 8 disc | 32 owner | 32 node | 32 mint | u64 amount @104 | u64 @112 | u64 @120 | u64 @128 ...
const STAKE_SIZE = 154;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createClient(rpcUrl) {
  const conn = new Connection(rpcUrl, "confirmed");
  const rewardCache = new Map(); // wallet -> node_rewards account

  const tokenAccountOf = owner =>
    PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), MINT.toBuffer()], ATA_PROG)[0];

  async function findStake(owner) {
    const found = await conn.getProgramAccounts(PROGRAM, {
      filters: [{ dataSize: STAKE_SIZE }, { memcmp: { offset: 8, bytes: owner.toBase58() } }],
    });
    return found[0] ?? null;
  }

  // Walk the stake record history: build a readable list and locate the node_rewards account.
  async function readHistory(stakeAddr, limit = 25) {
    const sigs = await conn.getSignaturesForAddress(stakeAddr, { limit });
    const history = [];
    let reward = null;
    for (const s of sigs) {
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const names = (tx?.meta?.logMessages ?? [])
        .filter(l => l.startsWith("Program log: Instruction: "))
        .map(l => l.slice(26))
        .filter(n => n !== "Transfer");
      history.push({ date: new Date(s.blockTime * 1000).toISOString().slice(0, 10), ok: !s.err, names, signature: s.signature });
      if (!reward && !s.err && tx) {
        const ix = tx.transaction.message.instructions.find(i => i.programId.equals(PROGRAM) && "accounts" in i && i.accounts.length);
        if (ix && (names.includes("ClaimRewards") || names.includes("InitializeNodeRewards"))) reward = ix.accounts[0];
        else if (ix && names.includes("WithdrawUnstakedTokens")) reward = ix.accounts[2];
      }
      await sleep(80); // be gentle with public RPC rate limits
    }
    return { history, reward };
  }

  async function info(walletStr) {
    const owner = new PublicKey(walletStr);
    const tokenAcc = tokenAccountOf(owner);
    const [tb, lamports, epochInfo] = await Promise.all([
      conn.getTokenAccountBalance(tokenAcc).catch(() => null),
      conn.getBalance(owner),
      conn.getEpochInfo(),
    ]);
    const result = {
      wallet: owner.toBase58(),
      shdw: tb?.value.uiAmountString ?? "0",
      sol: lamports / 1e9,
      epoch: epochInfo.epoch,
      stake: null,
    };
    const acc = await findStake(owner);
    if (!acc) return result;

    const d = acc.account.data;
    const f112 = Number(d.readBigUInt64LE(112));
    const f120 = Number(d.readBigUInt64LE(120));
    const f128 = Number(d.readBigUInt64LE(128));
    const { history, reward } = await readHistory(acc.pubkey);
    if (reward) rewardCache.set(owner.toBase58(), reward);

    result.stake = {
      address: acc.pubkey.toBase58(),
      node: new PublicKey(d.subarray(40, 72)).toBase58(),
      amount: Number(d.readBigUInt64LE(104)) / 1e9,
      stakedEpoch: f120,
      // A non-zero value in these fields appears after Unstake (heuristic, shown as a hint only)
      unstakeEpoch: f112 || f128 || null,
      history,
    };
    return result;
  }

  async function buildTx(walletStr, step) {
    const owner = new PublicKey(walletStr);
    const acc = await findStake(owner);
    if (!acc) throw new Error("No stake found for this wallet.");
    const W = p => ({ pubkey: p, isSigner: false, isWritable: true });
    const R = p => ({ pubkey: p, isSigner: false, isWritable: false });
    const SIGNER = { pubkey: owner, isSigner: true, isWritable: true };

    let ix;
    if (step === "unstake") {
      ix = new TransactionInstruction({
        programId: PROGRAM, data: IX_UNSTAKE,
        keys: [W(CONFIG), W(acc.pubkey), SIGNER, R(MINT)],
      });
    } else if (step === "withdraw") {
      let reward = rewardCache.get(owner.toBase58());
      if (!reward) {
        reward = (await readHistory(acc.pubkey, 50)).reward;
        if (reward) rewardCache.set(owner.toBase58(), reward);
      }
      if (!reward) throw new Error("Could not find the node rewards account for this wallet.");
      ix = new TransactionInstruction({
        programId: PROGRAM, data: IX_WITHDRAW,
        keys: [W(CONFIG), W(acc.pubkey), W(reward), R(MINT), R(VAULT_AUTH), W(VAULT), W(tokenAccountOf(owner)), R(TOKEN), SIGNER],
      });
    } else throw new Error("Unknown step.");

    const bh = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: owner,
      recentBlockhash: bh.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }), ix],
    }).compileToV0Message());
    return { tx, bh, owner };
  }

  async function simulate(walletStr, step) {
    const { tx } = await buildTx(walletStr, step);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    const logs = sim.value.logs ?? [];
    const msg = logs.find(l => l.includes("Error Message:"))?.split("Error Message:")[1]?.trim();
    return { ok: !sim.value.err, error: sim.value.err ? (msg ?? JSON.stringify(sim.value.err)) : null, logs };
  }

  async function send(walletStr, step, secretText) {
    const sim = await simulate(walletStr, step);
    if (!sim.ok) return { ok: false, error: `Simulation failed: ${sim.error}` };

    const { tx, bh, owner } = await buildTx(walletStr, step);
    let kp = parseSecretKey(secretText);
    if (!kp.publicKey.equals(owner)) {
      return { ok: false, error: `This key belongs to another wallet (${kp.publicKey.toBase58()}). Nothing was sent.` };
    }
    tx.sign([kp]);
    kp = null; // drop the reference as soon as the transaction is signed

    const signature = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    const bal = await conn.getTokenAccountBalance(tokenAccountOf(owner)).catch(() => null);
    return { ok: true, signature, shdw: bal?.value.uiAmountString ?? null };
  }

  return { info, simulate, send };
}

// ---------- private key parsing (base58 string or JSON array of 64 numbers)

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  const bytes = [0];
  for (const c of s) {
    let carry = ALPHABET.indexOf(c);
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

export function parseSecretKey(raw) {
  raw = String(raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) throw new Error("Paste the private key first.");
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 12 || words.length === 24) {
    throw new Error("This looks like a seed phrase. Export the PRIVATE KEY instead (Phantom: Settings → Manage accounts → account → Show private key).");
  }
  const cleaned = raw.replace(/[\s"'`]/g, "");
  const bad = [...cleaned].findIndex(c => !ALPHABET.includes(c));
  if (bad >= 0) throw new Error(`Invalid character at position ${bad + 1} of ${cleaned.length}. Copy the key again.`);
  const secret = b58decode(cleaned);
  if (secret.length !== 64) throw new Error(`The key is incomplete or has extra characters (${cleaned.length} chars). Copy it again.`);
  return Keypair.fromSecretKey(secret);
}
