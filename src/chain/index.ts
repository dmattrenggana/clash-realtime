// chain/index.ts — per-chain runtime configuration for the game server.
//
// 2026-11-03: Robinhood Chain (4663) preparation.
//
// Base (8453) is live; its addresses are the deployed ones. Robinhood (4663)
// is not deployed yet — its addresses come from the environment and the
// server refuses to serve that chain until they are set. It never falls back
// to the Base addresses, because validating a deck against the wrong chain
// would let a player battle with cards they do not own there.

import type { Address, Chain } from 'viem';
import { base } from 'viem/chains';
import { robinhood } from './robinhood.js';

export type SupportedChain = 'base' | 'robinhood';

export const CHAIN_IDS: Record<SupportedChain, number> = {
  base: 8453,
  robinhood: 4663,
};

export interface ChainConfig {
  id: SupportedChain;
  numericId: number;
  viemChain: Chain;
  rpcUrl: string;
  clashCardsAddress: Address;
  cardManagerAddress: Address;
  clashTokenAddress: Address;
}

const BASE_ADDRESSES = {
  clashCardsAddress: '0xF93643759c9C62E0e2E70969E2397806bE5CF609' as Address,
  cardManagerAddress: '0x425894394a636A95dc5Ed947dF7eE63d93062682' as Address,
  clashTokenAddress: '0xf3C66dc3afF9d04CbCEAfA8f9dE762a39EE0BBA3' as Address,
};

/**
 * Resolve the chain config.
 *
 * @throws when the requested chain has no configured contracts.
 */
export function getChainConfig(chain: SupportedChain = 'base'): ChainConfig {
  if (chain === 'base') {
    return {
      id: 'base',
      numericId: CHAIN_IDS.base,
      viemChain: base,
      rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      ...BASE_ADDRESSES,
    };
  }

  const clashCardsAddress = process.env.RH_CLASH_CARDS_ADDRESS as Address | undefined;
  const cardManagerAddress = process.env.RH_CARD_MANAGER_ADDRESS as Address | undefined;
  const clashTokenAddress = process.env.RH_CLASH_TOKEN_ADDRESS as Address | undefined;

  if (!clashCardsAddress || !cardManagerAddress || !clashTokenAddress) {
    throw new Error(
      'Robinhood Chain contracts are not configured (set RH_CLASH_CARDS_ADDRESS / ' +
        'RH_CARD_MANAGER_ADDRESS / RH_CLASH_TOKEN_ADDRESS)',
    );
  }

  return {
    id: 'robinhood',
    numericId: CHAIN_IDS.robinhood,
    viemChain: robinhood,
    rpcUrl: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    clashCardsAddress,
    cardManagerAddress,
    clashTokenAddress,
  };
}

/** Parse an untrusted chain key coming from a client. */
export function parseSupportedChain(value: unknown): SupportedChain {
  return value === 'robinhood' ? 'robinhood' : 'base';
}
