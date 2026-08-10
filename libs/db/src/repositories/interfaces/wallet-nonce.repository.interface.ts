export interface IWalletNonceRepository {
  /**
   * Atomically reserves and consumes the next nonce for the given wallet+chain
   * pair. The increment happens in the same statement as the read, so
   * concurrent callers always receive distinct nonces.
   *
   * The returned nonce must not be reused after a broadcast attempt. Callers
   * may release it only when signing fails before any raw transaction was
   * handed to an RPC provider.
   */
  reserve(walletId: string, chainId: number): Promise<number>;
  /**
   * Releases the most recently reserved nonce when no broadcast was attempted.
   * Returns false if a later reservation already exists.
   */
  release(walletId: string, chainId: number, nonce: number): Promise<boolean>;
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
