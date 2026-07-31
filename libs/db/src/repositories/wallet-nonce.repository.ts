import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../constants';
import type { DrizzleClient } from '../db';
import { wallet_nonces } from '../schema';
import type { IWalletNonceRepository } from './interfaces/wallet-nonce.repository.interface';

@Injectable()
export class WalletNonceRepository implements IWalletNonceRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async getAndLock(walletId: string, chainId: number): Promise<number> {
        // Run inside a transaction so the FOR UPDATE lock is held until the
        // calling service has finished building and broadcasting the transaction.
        // The transaction is committed by Drizzle when the callback returns.
        return this.db.transaction(async (tx) => {
            // Attempt a pessimistic lock on the existing row.
            const rows = await tx.execute(
                sql`SELECT nonce FROM wallet_nonces
                    WHERE wallet_id = ${walletId} AND chain_id = ${chainId}
                    FOR UPDATE`,
            );

            if (rows.rows.length > 0) {
                return Number((rows.rows[0] as { nonce: number }).nonce);
            }

            // Row does not exist — this wallet has never transacted on this chain.
            // Insert with nonce=0. Always start from 0 per product decision;
            // wallets managed by WalletMVP are assumed to have no prior history.
            await tx
                .insert(wallet_nonces)
                .values({
                    wallet_id: walletId,
                    chain_id: chainId,
                    nonce: 0,
                })
                .onConflictDoNothing(); // guard against a tight race at first insert

            return 0;
        });
    }

    async increment(walletId: string, chainId: number): Promise<void> {
        await this.db
            .update(wallet_nonces)
            .set({
                nonce: sql`nonce + 1`,
                updated_at: sql`now()`,
            })
            .where(
                sql`wallet_id = ${walletId} AND chain_id = ${chainId}`,
            );
    }
}