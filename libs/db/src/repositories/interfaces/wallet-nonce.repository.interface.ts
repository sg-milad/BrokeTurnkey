export interface IWalletNonceRepository {
  /**
   * Atomically reserves and consumes the next nonce for the given wallet+chain
   * pair. The increment happens in the same statement as the read, so
   * concurrent callers always receive distinct nonces.
   *
   * The returned nonce is permanently consumed — callers must not retry with
   * the same value after a failure.
   */
  reserve(walletId: string, chainId: number): Promise<number>;
}
