export interface IWalletNonceRepository {
    /**
     * Returns the current nonce for the given wallet+chain pair, using a
     * pessimistic lock (SELECT ... FOR UPDATE) to prevent concurrent requests
     * from obtaining the same nonce.
     *
     * If no row exists yet, inserts one with nonce=0 and returns 0.
     * The caller is responsible for calling incrementNonce() after a
     * successful broadcast.
     */
    getAndLock(walletId: string, chainId: number): Promise<number>;

    /**
     * Atomically increments the nonce for the given wallet+chain pair by 1.
     * Must be called only after a confirmed broadcast.
     */
    increment(walletId: string, chainId: number): Promise<void>;
}