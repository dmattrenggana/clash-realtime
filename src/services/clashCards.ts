// clashCards.ts — On-chain ClashCards NFT queries for the game server.
//
// SOURCE OF TRUTH = on-chain. The DB (card_inventory) is just a cache/mirror;
// the server ALWAYS reads from the contract to validate ownership and level.
//
// Each (cardType, level) is a unique ERC-1155 NFT:
//   tokenId = cardTypeId * 256 + (level - 1)
//
// We query balanceOf(wallet, tokenId) for each level of each card type,
// find the maximum level owned (>= 1 NFT), and return that for battle scaling.

import { createPublicClient, http, getAddress, type Address } from "viem";
import { base } from "viem/chains";

const CLASH_CARDS_ADDRESS = getAddress(
  "0xF93643759c9C62E0e2E70969E2397806bE5CF609"
);

// On-chain RPC used for Battle Deck ownership validation in BattleRoom.onJoin.
//
// mainnet.base.org is the free public endpoint. It works, but it rate-limits
// aggressively and returns 413 on the heavier multicall/batch queries that
// getOwnedCardsOnChain issues — one busy moment and every player trying to
// join gets rejected with DECK_VALIDATION_FAILED.
//
// Preferred: set BASE_RPC_URL to a private endpoint (Alchemy / Infura /
// QuickNode free tiers all cover Base). When it's absent we fall back to the
// public node rather than failing outright, and the transport below is tuned
// to tolerate the flakiness that comes with it.
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const USING_PUBLIC_RPC = !process.env.BASE_RPC_URL;

if (USING_PUBLIC_RPC) {
  console.warn(
    "[clashCards] BASE_RPC_URL is not set — falling back to the rate-limited " +
      "public endpoint https://mainnet.base.org. Deck validation may fail " +
      "under load. Set BASE_RPC_URL to a private RPC to remove this risk.",
  );
}

export const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL, {
    // The public node stalls on batch requests; give it room before we give up.
    timeout: USING_PUBLIC_RPC ? 15_000 : 10_000,
    // Retry transient failures (rate limit, gateway blip) instead of failing
    // the player's join outright.
    retryCount: 3,
    retryDelay: 400,
  }),
});

/** Map cardId → cardTypeId (0..12). */
export const CARD_TYPE_IDS: Record<string, number> = {
  knight: 0,
  archer: 1,
  giant: 2,
  wyvern: 3,
  wizard: 4,
  goblin: 5,
  barbarian: 6,
  healer: 7,
  gunslinger: 8,
  barrel_bomb: 9,
  meteor: 10,
  incubus: 11,
  robinhood: 12,
};

/** Reverse: cardTypeId → cardId. */
export const CARD_IDS_BY_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(CARD_TYPE_IDS).map(([id, type]) => [type, id])
);

/** Max card level (per ClashCards contract maxLevel()). */
export const MAX_CARD_LEVEL = 9;

/**
 * Encode (cardTypeId, level) → tokenId.
 *   tokenId = cardTypeId × 256 + (level - 1)
 */
export function tokenIdOf(cardTypeId: number, level: number): bigint {
  return BigInt(cardTypeId) * 256n + BigInt(level - 1);
}

/**
 * Decode tokenId → { cardTypeId, level }.
 */
export function decodeTokenId(tokenId: bigint): { cardTypeId: number; level: number } {
  return {
    cardTypeId: Number(tokenId / 256n),
    level: Number(tokenId % 256n) + 1,
  };
}

/** ERC-1155 + ClashCards custom ABI (subset). */
const CLASH_CARDS_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maxLevel",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface CardOwnership {
  cardId: string;
  cardTypeId: number;
  /** Max level the wallet owns at least 1 NFT of. 0 = wallet doesn't own this card. */
  maxLevel: number;
  /** Total NFTs owned across all levels (sum of balances). */
  totalBalance: number;
}

/**
 * In-memory TTL cache for getOwnedCardsOnChain().
 * Avoids hammering RPC for repeated battles from the same wallet.
 *
 * TTL: 30 seconds — enough for a typical match (60-180s) but covers
 * multi-tab/window refresh without re-querying. Also avoids rate-limit
 * issues with public mainnet.base.org.
 *
 * For multi-instance deployments, swap this for Redis. For single
 * process (current setup), in-memory Map is fine.
 */
const ownershipCache = new Map<string, { data: CardOwnership[]; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/** Get cached ownership (for tests / debugging). */
export function _getOwnershipCacheSize(): number {
  return ownershipCache.size;
}

/**
 * Query the ClashCards contract for all cards owned by a wallet.
 *
 * Strategy:
 *   1. For each of the 12 card types, query balanceOf for levels 1..MAX_CARD_LEVEL.
 *   2. Find max level where balance > 0.
 *   3. Sum total balances for this card type.
 *
 * Performance:
 *   12 card types × MAX_CARD_LEVEL (9) = 108 balanceOf calls.
 *   Run in parallel via Promise.all — ~500ms-2s on Base mainnet.
 */
export async function getOwnedCardsOnChain(
  wallet: Address | string
): Promise<CardOwnership[]> {
  const walletAddr = getAddress(wallet);

  // Check cache first (TTL 30s). Avoids RPC hits for repeat battles
  // and protects against public RPC rate limits.
  const cached = ownershipCache.get(walletAddr.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const contracts: Array<{ address: `0x${string}`; abi: typeof CLASH_CARDS_ABI; functionName: "balanceOf"; args: readonly [bigint, `0x${string}`] }> = [];

  for (const cardId of Object.keys(CARD_TYPE_IDS)) {
    const cardTypeId = CARD_TYPE_IDS[cardId];
    for (let level = 1; level <= MAX_CARD_LEVEL; level++) {
      const tokenId = tokenIdOf(cardTypeId, level);
      contracts.push({
        address: CLASH_CARDS_ADDRESS,
        abi: CLASH_CARDS_ABI,
        functionName: "balanceOf",
        args: [tokenId, walletAddr],
      });
    }
  }

  // Use multicall for batched on-chain reads (1 RPC call vs 108)
  const balances = await (publicClient.multicall as any)({
    contracts,
    allowFailure: false,
  });

  // Aggregate by cardTypeId
  const ownershipMap = new Map<number, { maxLevel: number; total: number }>();
  for (const cardId of Object.keys(CARD_TYPE_IDS)) {
    const cardTypeId = CARD_TYPE_IDS[cardId];
    ownershipMap.set(cardTypeId, { maxLevel: 0, total: 0 });
  }

  let idx = 0;
  for (const cardId of Object.keys(CARD_TYPE_IDS)) {
    const cardTypeId = CARD_TYPE_IDS[cardId];
    let maxLevel = 0;
    let total = 0;
    for (let level = 1; level <= MAX_CARD_LEVEL; level++) {
      const balance = Number(balances[idx++]);
      if (balance > 0) {
        total += balance;
        if (level > maxLevel) maxLevel = level;
      }
    }
    ownershipMap.set(cardTypeId, { maxLevel, total });
  }

  const result = Object.keys(CARD_TYPE_IDS).map((cardId) => {
    const cardTypeId = CARD_TYPE_IDS[cardId];
    const { maxLevel, total } = ownershipMap.get(cardTypeId)!;
    return {
      cardId,
      cardTypeId,
      maxLevel,
      totalBalance: total,
    };
  });

  // Cache result for 30s — avoids RPC hits for repeat battles
  // and protects against public mainnet.base.org rate limits.
  ownershipCache.set(walletAddr.toLowerCase(), {
    data: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return result;
}

/**
 * Query on-chain NFT ownership for ONE specific (cardId, level) pair.
 * Used for fast ad-hoc checks (e.g., during upgrade flow).
 */
export async function getBalanceOnChain(
  wallet: Address | string,
  cardId: string,
  level: number
): Promise<number> {
  const cardTypeId = CARD_TYPE_IDS[cardId];
  if (cardTypeId === undefined) {
    throw new Error(`Unknown cardId: ${cardId}`);
  }
  const balance = (await publicClient.readContract({
    address: CLASH_CARDS_ADDRESS,
    abi: CLASH_CARDS_ABI,
    functionName: "balanceOf",
    args: [tokenIdOf(cardTypeId, level), getAddress(wallet)],
  } as any)) as bigint;
  return Number(balance);
}

/**
 * Card level multiplier for HP and damage scaling.
 * Source of truth: Clash Royale-style curve, +10% per level above L1.
 *   L1 = 1.0, L2 = 1.10, L3 = 1.20, ..., L9 = 1.80
 *
 * L1 NFTs do NO scaling — they use base stats as-is.
 */
export const LEVEL_MULTIPLIERS: Record<number, number> = {
  1: 1.00,
  2: 1.10,
  3: 1.20,
  4: 1.30,
  5: 1.40,
  6: 1.50,
  7: 1.60,
  8: 1.70,
  9: 1.80,
};

export function getLevelMultiplier(level: number): number {
  return LEVEL_MULTIPLIERS[level] ?? 1.0;
}

/**
 * Apply level scaling to a base stat (HP, damage, attack speed).
 * Negative or zero levels return 1.0 (no scaling).
 */
export function scaleStatByLevel(baseStat: number, level: number): number {
  const multiplier = getLevelMultiplier(level);
  return Math.round(baseStat * multiplier);
}