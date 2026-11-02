// robinhood.ts — Robinhood Chain (4663) definition.
//
// The installed viem (2.53.1) predates the upstream `robinhood` chain entry,
// so it is defined locally. Keep the shape identical to viem's definition:
// id, native currency, RPC URLs, explorer.

import { defineChain } from 'viem';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://rpc.mainnet.chain.robinhood.com',
        'https://rpc.ordofi.network',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
    },
  },
  testnet: false,
});
