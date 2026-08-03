import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChainConfig, SUPPORTED_CHAINS } from './chain.config';

@Injectable()
export class ChainService implements OnModuleInit {
  private readonly logger = new Logger(ChainService.name);
  private readonly chains = new Map<number, ChainConfig>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    for (const [chainId, meta] of Object.entries(SUPPORTED_CHAINS)) {
      const rpcUrls = this.resolveRpcUrls(meta.envKey);
      if (rpcUrls.length === 0) {
        this.logger.warn(
          `No RPC URLs configured for chain ${meta.name} (${chainId}). ` +
            `Set RPC_${meta.envKey}_1 in your environment.`,
        );
        continue;
      }

      this.chains.set(Number(chainId), {
        ...meta,
        rpcUrls,
      });

      this.logger.log(
        `Registered chain ${meta.name} (${chainId}) with ${rpcUrls.length} RPC provider(s)`,
      );
    }

    if (this.chains.size === 0) {
      this.logger.error(
        'No chains configured! Set at least one RPC_<CHAIN>_1 env var.',
      );
    }
  }

  /**
   * Get the full chain config for a given chainId.
   * Throws if the chain is not registered.
   */
  getChain(chainId: number): ChainConfig {
    const chain = this.chains.get(chainId);
    if (!chain) {
      throw new Error(
        `Unsupported chain ID: ${chainId}. Supported: ${[...this.chains.keys()].join(', ')}`,
      );
    }
    return chain;
  }

  /**
   * Get ordered RPC URLs for a chain (primary first).
   */
  getRpcUrls(chainId: number): string[] {
    return this.getChain(chainId).rpcUrls;
  }

  /**
   * Check if a chain is supported and configured.
   */
  isSupported(chainId: number): boolean {
    return this.chains.has(chainId);
  }

  /**
   * List all configured chain IDs.
   */
  getSupportedChainIds(): number[] {
    return [...this.chains.keys()];
  }

  /**
   * Resolve RPC URLs from env vars using the pattern:
   *   RPC_<ENVKEY>_1, RPC_<ENVKEY>_2, RPC_<ENVKEY>_3, ...
   *
   * Falls back to legacy RPC_URL / RPC_URL_FALLBACK for backward compat
   * when ENVKEY matches the old single-chain setup.
   */
  private resolveRpcUrls(envKey: string): string[] {
    const urls: string[] = [];

    // Try numbered pattern: RPC_<ENVKEY>_1, _2, _3, ...
    for (let i = 1; i <= 5; i++) {
      const url = this.config.get<string>(`RPC_${envKey}_${i}`);
      if (url) {
        urls.push(url);
      }
    }

    // Legacy fallback: if no numbered URLs found and this looks like
    // the default chain, try the old RPC_URL / RPC_URL_FALLBACK vars
    if (urls.length === 0) {
      const legacyPrimary = this.config.get<string>('RPC_URL');
      const legacyFallback = this.config.get<string>('RPC_URL_FALLBACK');

      if (legacyPrimary) {
        urls.push(legacyPrimary);
      }
      if (legacyFallback) {
        urls.push(legacyFallback);
      }
    }

    return urls;
  }
}
