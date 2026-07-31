import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { CryptoClientService } from '@app/crypto-client';
import { GasService } from '@app/gas';
import {
    organizationSeedRepository,
    WalletRepository,
    SigningRequestRepository,
    AuditLogRepository,
    UserRepository,
} from '@app/db/repositories';
import { TxFields } from '@app/crypto-client/interfaces/crypto-client.interfaces';

// Fields the caller provides. Gas fields are optional — GasService fills them in.
export interface SignRequest {
    chainId: number;
    to: string;
    value: string;   // decimal string, wei
    data: string;    // 0x-prefixed hex
    // Optional overrides — if omitted, GasService estimates them
    gasLimit?: number;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
}

export interface SignResult {
    txHash: string;
    signature: string;
    receipt: {
        blockNumber: number;
        status: number;
    } | null;
    status: 'confirmed' | 'timeout';
    signingRequestId: string;
}

@Injectable()
export class WalletService {
    private readonly logger = new Logger(WalletService.name);

    constructor(
        private readonly cryptoClient: CryptoClientService,
        private readonly gasService: GasService,
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
            if (!user) throw new NotFoundException(`User with id "${userId}" does not exist`);
            if (user.org_id !== orgId) {
                throw new BadRequestException(
                    `User "${userId}" does not belong to organization "${orgId}"`,
                );
            }
        }

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

    async requestSign(orgId: string, walletId: string, req: SignRequest): Promise<SignResult> {
        // 1. Load prerequisites
        const [seedRow, wallet] = await Promise.all([
            this.orgSeedRepo.findByOrgId(orgId),
            this.walletRepo.findById(walletId),
        ]);

        if (!seedRow) throw new BadRequestException('Org has not been onboarded');
        if (!wallet) throw new NotFoundException(`Wallet "${walletId}" not found`);
        if (wallet.org_id !== orgId) throw new BadRequestException('Wallet does not belong to this org');

        // 2. Estimate fees if not provided by caller
        const fees = await this.gasService.estimateFees(
            req.to,
            req.value,
            req.data,
            req.chainId,
            wallet.address,
        );

        const gasLimit = req.gasLimit ?? fees.gasLimit;
        const maxFeePerGas = req.maxFeePerGas ?? fees.maxFeePerGas;
        const maxPriorityFeePerGas = req.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;

        // 3. Get + lock nonce (pessimistic lock held until after broadcast)
        const nonce = await this.gasService.getNextNonce(walletId, req.chainId);

        const txFields: TxFields = {
            chainId: req.chainId,
            nonce,
            to: req.to,
            value: req.value,
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            data: req.data,
        };

        // 4. Write a pending signing_request record before touching the signer.
        //    If the process crashes after signing but before broadcast, this row
        //    surfaces the in-flight transaction for manual investigation.
        const signingRequest = await this.signingRequestRepo.create({
            org_id: orgId,
            wallet_id: walletId,
            tx_payload: JSON.parse(JSON.stringify(txFields)),
            status: 'pending',
        });

        // 5. Sign via Go sidecar — returns signature, txHash, rawTx
        let signResult: Awaited<ReturnType<CryptoClientService['signTransaction']>>;
        try {
            signResult = await this.cryptoClient.signTransaction(
                seedRow.encrypted_seed,
                seedRow.seed_nonce,
                seedRow.encrypted_dek,
                wallet.derivation_path,
                txFields,
            );
        } catch (err) {
            await this.signingRequestRepo.update(signingRequest.id, {
                status: 'failed',
                failure_reason: (err as Error).message,
            });
            throw err;
        }

        // 6. Update signing_request with the hash + signature now that signing succeeded
        await this.signingRequestRepo.update(signingRequest.id, {
            tx_hash: signResult.txHash,
            signature: signResult.signature,
            status: 'signed',
            signed_at: new Date(),
        });

        // 7. Broadcast
        try {
            await this.gasService.broadcastTransaction(signResult.rawTx);
        } catch (err) {
            await this.signingRequestRepo.update(signingRequest.id, {
                status: 'failed',
                failure_reason: `broadcast failed: ${(err as Error).message}`,
            });
            throw err;
        }

        // 8. Nonce increment — only after successful broadcast
        await this.gasService.incrementNonce(walletId, req.chainId);

        // 9. Poll for receipt
        const { receipt, timedOut } = await this.gasService.waitForReceipt(
            signResult.txHash,
            60_000,
        );

        // 10. Final signing_request status
        const finalStatus = timedOut ? 'timeout' : receipt?.status === 1 ? 'confirmed' : 'failed';

        await this.signingRequestRepo.update(signingRequest.id, {
            status: finalStatus,
            ...(timedOut ? { failure_reason: 'receipt polling timed out' } : {}),
        });

        // 11. Audit log
        await this.auditLogRepo.create({
            org_id: orgId,
            wallet_id: walletId,
            event: 'tx_signed',
            status: timedOut ? 'timeout' : 'success',
            metadata: {
                txHash: signResult.txHash,
                signingRequestId: signingRequest.id,
                chainId: req.chainId,
                finalStatus,
            },
        });

        return {
            txHash: signResult.txHash,
            signature: signResult.signature,
            receipt: receipt
                ? { blockNumber: receipt.blockNumber, status: receipt.status }
                : null,
            status: timedOut ? 'timeout' : 'confirmed',
            signingRequestId: signingRequest.id,
        };
    }
}