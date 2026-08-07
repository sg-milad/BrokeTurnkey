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
  /**
   * Updates the nonce for the given wallet+chain pair to the provided value if
   * it is greater than the current value. This is used to synchronize the
   * nonce with the chain after a successful broadcast.
   */
  syncFromChain(
    walletId: string,
    chainId: number,
    chainNonce: number,
  ): Promise<void>;
}
