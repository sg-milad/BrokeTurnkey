import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { CryptoClientService } from '@app/crypto-client';
import { GasService, ErrorType, classifyError } from '@app/gas';
import {
  organizationSeedRepository,
  WalletRepository,
  SigningRequestRepository,
  AuditLogRepository,
  UserRepository,
} from '@app/db/repositories';
import { TxFields } from '@app/crypto-client/interfaces/crypto-client.interfaces';
import { createHash } from 'crypto';

// Fields the caller provides. Gas fields are optional — GasService fills them in.
export interface SignRequest {
  chainId: number;
  to: string;
  value: string; // decimal string, wei
  data: string; // 0x-prefixed hex
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
    gasUsed?: string;
    effectiveGasPrice?: string;
  } | null;
  status: 'confirmed' | 'timeout' | 'failed';
  signingRequestId: string;
  errorType?: ErrorType;
  errorMessage?: string;
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
  ) {}

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
    if (!seedRow)
      throw new BadRequestException('organization has not been onboarded');

    if (userId) {
      const user = await this.userRepo.findById(userId);
      if (!user)
        throw new NotFoundException(`User with id "${userId}" does not exist`);
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
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
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
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
    return this.signingRequestRepo.findByWalletId(walletId);
  }

  async requestSign(
    orgId: string,
    walletId: string,
    req: SignRequest,
  ): Promise<SignResult> {
    // 1. Load prerequisites
    const [seedRow, wallet] = await Promise.all([
      this.orgSeedRepo.findByOrgId(orgId),
      this.walletRepo.findById(walletId),
    ]);

    if (!seedRow) throw new BadRequestException('Org has not been onboarded');
    if (!wallet) throw new NotFoundException(`Wallet "${walletId}" not found`);
    if (wallet.org_id !== orgId)
      throw new BadRequestException('Wallet does not belong to this org');

    // 2. Idempotency check - compute key from request params
    const idempotencyKey = this.computeIdempotencyKey(walletId, req);
    const existingRequest =
      await this.signingRequestRepo.findByIdempotencyKey(idempotencyKey);

    if (existingRequest && existingRequest.status !== 'failed') {
      this.logger.log(
        `Returning existing signing request ${existingRequest.id} for idempotency key ${idempotencyKey}`,
      );
      return this.buildSignResultFromRequest(existingRequest);
    }

    // 3. Estimate fees if not provided by caller
    const fees = await this.gasService.estimateFees(
      req.to,
      req.value,
      req.data,
      req.chainId,
      wallet.address,
    );

    const gasLimit = req.gasLimit ?? fees.gasLimit;
    const maxFeePerGas = req.maxFeePerGas ?? fees.maxFeePerGas;
    const maxPriorityFeePerGas =
      req.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;

    // 4. Get + lock nonce
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

    // 5. Create pending signing_request with idempotency key
    const signingRequest = await this.signingRequestRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      tx_payload: JSON.parse(JSON.stringify(txFields)),
      status: 'pending',
      idempotency_key: idempotencyKey,
    });

    // 6. Sign via Go sidecar
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
      const errorType = classifyError(err as Error);
      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'failed',
        failure_reason: (err as Error).message,
        error_type: errorType,
      });
      throw err;
    }

    // 7. Update signing_request with hash + signature
    await this.signingRequestRepo.update(signingRequest.id, {
      tx_hash: signResult.txHash,
      signature: signResult.signature,
      status: 'signed',
      signed_at: new Date(),
    });

    // 8. Broadcast with retry
    try {
      await this.gasService.broadcastTransaction(signResult.rawTx);

      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'broadcasted',
        broadcasted_at: new Date(),
      });
    } catch (err) {
      const errorType = classifyError(err as Error);
      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'failed',
        failure_reason: `broadcast failed: ${(err as Error).message}`,
        error_type: errorType,
      });
      throw err;
    }

    // 9. Increment nonce only after successful broadcast
    await this.gasService.incrementNonce(walletId, req.chainId);

    // 10. Poll for receipt
    const { receipt, timedOut } = await this.gasService.waitForReceipt(
      signResult.txHash,
      60_000,
    );

    // 11. Final status and update
    let finalStatus: 'confirmed' | 'timeout' | 'failed' = 'timeout';
    let errorType: ErrorType | undefined;
    let errorMessage: string | undefined;

    if (!timedOut && receipt) {
      finalStatus = receipt.status === 1 ? 'confirmed' : 'failed';

      await this.signingRequestRepo.update(signingRequest.id, {
        status: finalStatus,
        block_number: receipt.blockNumber,
        gas_used: receipt.gasUsed || null,
        effective_gas_price: receipt.effectiveGasPrice || null,
        confirmed_at: finalStatus === 'confirmed' ? new Date() : undefined,
      });
    } else if (timedOut) {
      errorMessage = 'receipt polling timed out';
      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'timeout',
        failure_reason: errorMessage,
      });
    }

    // 12. Audit log
    await this.auditLogRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      event: 'tx_signed',
      status: finalStatus === 'confirmed' ? 'success' : finalStatus,
      metadata: {
        txHash: signResult.txHash,
        signingRequestId: signingRequest.id,
        chainId: req.chainId,
        finalStatus,
        errorType,
      },
    });

    return {
      txHash: signResult.txHash,
      signature: signResult.signature,
      receipt: receipt
        ? {
            blockNumber: receipt.blockNumber,
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
          }
        : null,
      status: finalStatus,
      signingRequestId: signingRequest.id,
      errorType,
      errorMessage,
    };
  }

  private computeIdempotencyKey(walletId: string, req: SignRequest): string {
    const payload = `${walletId}:${req.chainId}:${req.to}:${req.value}:${req.data}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  private buildSignResultFromRequest(request: any): SignResult {
    return {
      txHash: request.tx_hash || '',
      signature: request.signature || '',
      receipt: request.block_number
        ? {
            blockNumber: request.block_number,
            status: request.status === 'confirmed' ? 1 : 0,
            gasUsed: request.gas_used,
            effectiveGasPrice: request.effective_gas_price,
          }
        : null,
      status:
        request.status === 'timeout'
          ? 'timeout'
          : request.status === 'confirmed'
            ? 'confirmed'
            : 'failed',
      signingRequestId: request.id,
      errorType: request.error_type as ErrorType | undefined,
      errorMessage: request.failure_reason || undefined,
    };
  }
}
