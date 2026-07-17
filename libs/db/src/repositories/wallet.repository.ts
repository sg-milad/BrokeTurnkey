import { Injectable, Inject } from '@nestjs/common';
import type { DrizzleClient } from '../db';
import { DRIZZLE_CLIENT } from '../database.module';
import { IWalletRepository } from '../repositories/interfaces/wallet.repository.interface';
import { Wallet, NewWallet, wallets } from '../schema/wallets';
import { eq, count } from 'drizzle-orm';

@Injectable()
export class WalletRepository implements IWalletRepository {
    constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

    async findByOrgId(orgId: string): Promise<Wallet[]> {
        return await this.db.select().from(wallets).where(eq(wallets.org_id, orgId));
    }

    async findById(id: string): Promise<Wallet | undefined> {
        const result = await this.db.select().from(wallets).where(eq(wallets.id, id));
        return result[0];
    }

    async countByOrgId(orgId: string): Promise<number> {
        const result = await this.db.select({ count: count() }).from(wallets).where(eq(wallets.org_id, orgId));
        return Number(result[0].count);
    }

    async create(data: NewWallet): Promise<Wallet> {
        const result = await this.db.insert(wallets).values(data).returning();
        return result[0];
    }
}
