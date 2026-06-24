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

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

export const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

/** Map cardId → cardTypeId (0..11). */
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

  return Object.keys(CARD_TYPE_IDS).map((cardId) => {
    const cardTypeId = CARD_TYPE_IDS[cardId];
    const { maxLevel, total } = ownershipMap.get(cardTypeId)!;
    return {
      cardId,
      cardTypeId,
      maxLevel,
      totalBalance: total,
    };
  });
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