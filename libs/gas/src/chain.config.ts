export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrls: string[]; // ordered by priority, first = primary
  blockExplorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

/**
 * Registry of supported EVM chains.
 *
 * RPC URLs are loaded from environment variables at runtime via ChainService.
 * This static registry defines the chain metadata and the env-var keys used
 * to resolve RPC endpoints. Each key maps to an env var pattern:
 *   RPC_<KEY>_1, RPC_<KEY>_2, ...
 *
 * To add a new chain:
 *   1. Add an entry here with the envKey
 *   2. Set RPC_<ENVKEY>_1 (and optionally _2, _3) in your .env
 * for example for Ethereum Mainnet:
 *   1. Add entry:
 *      1: { chainId: 1, name: 'Ethereum', envKey: 'ETH_MAINNET', ... }
 *   2. Set env var:
 *      RPC_ETH_MAINNET_1=https://mainnet.infura.io/v3/YOUR-PROJECT-ID
 *  
 *
 *
 * The ChainService will read the env vars and register the chain at runtime.
 */
export const SUPPORTED_CHAINS: Record<
  number,
  Omit<ChainConfig, 'rpcUrls'> & { envKey: string }
> = {
  // Ethereum Mainnet
  1: {
    chainId: 1,
    name: 'Ethereum',
    envKey: 'ETH_MAINNET',
    blockExplorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Ethereum Sepolia
  11155111: {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    envKey: 'ETH_SEPOLIA',
    blockExplorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  },
  // Base
  8453: {
    chainId: 8453,
    name: 'Base',
    envKey: 'BASE_MAINNET',
    blockExplorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Base Sepolia
  84532: {
    chainId: 84532,
    name: 'Base Sepolia',
    envKey: 'BASE_SEPOLIA',
    blockExplorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  },
  // Optimism
  10: {
    chainId: 10,
    name: 'OP Mainnet',
    envKey: 'OP_MAINNET',
    blockExplorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Arbitrum One
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    envKey: 'ARB_MAINNET',
    blockExplorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Polygon
  137: {
    chainId: 137,
    name: 'Polygon',
    envKey: 'POLYGON_MAINNET',
    blockExplorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  },
};
