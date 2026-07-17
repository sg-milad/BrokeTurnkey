import { Injectable } from '@nestjs/common';
import { CryptoClientService } from '@app/crypto-client';
import {
    OrganisationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
} from '@app/db/repositories';
import { TxFields } from '@app/crypto-client/interfaces/crypto-client.interfaces';

@Injectable()
export class WalletService {
    constructor(
        private readonly cryptoClient: CryptoClientService,
        private readonly orgSeedRepo: OrganisationSeedRepository,
        private readonly walletRepo: WalletRepository,
        private readonly signingRequestRepo: SigningRequestRepository,
        private readonly auditLogRepo: AuditLogRepository,
    ) { }

    async onboardOrganisation(orgId: string) {
        const { encryptedSeed, seedNonce, encryptedDek, firstAddress } = await this.cryptoClient.createWallet(orgId);

        await this.orgSeedRepo.create({
            org_id: orgId,
            encrypted_seed: encryptedSeed,
            seed_nonce: seedNonce,
            encrypted_dek: encryptedDek,
        });

        //TODO: use uuid generator for this part
        await this.walletRepo.create({
            org_id: orgId,
            user_id: "00000000-0000-0000-0000-000000000000", // Need user context, placeholder for now
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

    async deriveWallet(orgId: string, userId: string, label: string) {
        const seedRow = await this.orgSeedRepo.findByOrgId(orgId);
        if (!seedRow) throw new Error('Org seed not found');

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

    async requestSign(orgId: string, walletId: string, txFields: TxFields) {
        const seedRow = await this.orgSeedRepo.findByOrgId(orgId);
        if (!seedRow) throw new Error('Org seed not found');

        const wallet = await this.walletRepo.findById(walletId);
        if (!wallet) throw new Error('Wallet not found');

        const { signature, txHash } = await this.cryptoClient.signTransaction(
            seedRow.encrypted_seed,
            seedRow.seed_nonce,
            seedRow.encrypted_dek,
            wallet.derivation_path,
            txFields,
        );

        const request = await this.signingRequestRepo.create({
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
            metadata: { txHash, request },
        });

        return { signature, txHash };
    }
}
