import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CryptoClientService } from '@app/crypto-client';
import {
    organizationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    UserRepository,
} from '@app/db/repositories';
import { TxFields } from '@app/crypto-client/interfaces/crypto-client.interfaces';

@Injectable()
export class WalletService {
    constructor(
        private readonly cryptoClient: CryptoClientService,
        private readonly orgSeedRepo: organizationSeedRepository,
        private readonly walletRepo: WalletRepository,
        private readonly signingRequestRepo: SigningRequestRepository,
        private readonly auditLogRepo: AuditLogRepository,
        private readonly userRepo: UserRepository,
    ) { }

    async onBoardOrganization(orgId: string) {
        const existing = await this.orgSeedRepo.findByOrgId(orgId);
        if (existing) throw new Error('organization already onboarded');

        const { encryptedSeed, seedNonce, encryptedDek, firstAddress } =
            await this.cryptoClient.createWallet();

        await this.orgSeedRepo.create({
            org_id: orgId,
            encrypted_seed: encryptedSeed,
            seed_nonce: seedNonce,
            encrypted_dek: encryptedDek,
        });

        // First wallet is org-owned (no user). user_id is intentionally null.
        await this.walletRepo.create({
            org_id: orgId,
            user_id: null,
            address: firstAddress,
            derivation_path: "m/44'/60'/0'/0/0",
        });

        await this.auditLogRepo.create({
            org_id: orgId,
            event: 'org_onboarded',
            status: 'success',
        });

        return { orgId, firstAddress };
    }

    async deriveWallet(orgId: string, userId: string | undefined, label: string) {
        const seedRow = await this.orgSeedRepo.findByOrgId(orgId);
        if (!seedRow) throw new BadRequestException('organization has not been onboarded');

        if (userId) {
            const user = await this.userRepo.findById(userId);
            if (!user) {
                throw new NotFoundException(`User with id "${userId}" does not exist`);
            }
            if (user.org_id !== orgId) {
                throw new BadRequestException(
                    `User "${userId}" does not belong to organization "${orgId}"`,
                );
            }
        }

        // NOTE: countByOrgId has a race condition under concurrent requests for
        // the same org. The unique index on (org_id, derivation_path) will catch
        // collisions and throw — handle that at the controller level and retry once.
        const derivIndex = await this.walletRepo.countByOrgId(orgId);

        const { address, derivationPath } = await this.cryptoClient.deriveWallet(
            seedRow.encrypted_seed,
            seedRow.seed_nonce,
            seedRow.encrypted_dek,
            derivIndex,
        );

        const wallet = await this.walletRepo.create({
            org_id: orgId,
            user_id: userId,
            label,
            address,
            derivation_path: derivationPath,
        });

        await this.auditLogRepo.create({
            org_id: orgId,
            user_id: userId,
            wallet_id: wallet.id,
            event: 'wallet_created',
            status: 'success',
        });

        return { walletId: wallet.id, address, derivationPath };
    }

    async listWalletsByOrgId(orgId: string) {
        const wallets = await this.walletRepo.findByOrgId(orgId);
        return wallets.map((w) => ({
            id: w.id,
            address: w.address,
            label: w.label,
            user_id: w.user_id,
            status: w.status,
            created_at: w.created_at,
        }));
    }

    async getWalletById(walletId: string) {
        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) throw new NotFoundException(`Wallet with id "${walletId}" does not exist`);
        return {
            id: wallet.id,
            org_id: wallet.org_id,
            address: wallet.address,
            label: wallet.label,
            user_id: wallet.user_id,
            status: wallet.status,
            created_at: wallet.created_at,
        };
    }

    async listSigningRequestsByOrgId(orgId: string) {
        return this.signingRequestRepo.findByOrgId(orgId);
    }

    async listSigningRequestsByWalletId(walletId: string) {
        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) throw new NotFoundException(`Wallet with id "${walletId}" does not exist`);
        return this.signingRequestRepo.findByWalletId(walletId);
    }

    async requestSign(orgId: string, walletId: string, txFields: TxFields) {
        const seedRow = await this.orgSeedRepo.findByOrgId(orgId);
        if (!seedRow) throw new Error('Org seed not found');

        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) throw new Error('Wallet not found');

        // Guard: ensure the wallet actually belongs to this org
        if (wallet.org_id !== orgId) throw new Error('Wallet does not belong to this org');

        const { signature, txHash } = await this.cryptoClient.signTransaction(
            seedRow.encrypted_seed,
            seedRow.seed_nonce,
            seedRow.encrypted_dek,
            wallet.derivation_path,
            txFields,
        );

        const signingRequest = await this.signingRequestRepo.create({
            org_id: orgId,
            wallet_id: walletId,
            tx_hash: txHash,
            tx_payload: JSON.parse(JSON.stringify(txFields)),
            signature,
            status: 'signed',
        });

        await this.auditLogRepo.create({
            org_id: orgId,
            wallet_id: walletId,
            event: 'tx_signed',
            status: 'success',
            metadata: { txHash, signingRequestId: signingRequest.id },
        });

        return { signature, txHash };
    }
}