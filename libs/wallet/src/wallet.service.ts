import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { CryptoClientService } from '@app/crypto-client';
import { GasService, ErrorType, classifyError } from '@app/gas';
import { PolicyService } from '@app/policy';
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
    private readonly policyService: PolicyService,
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

  async deriveWallet(
    orgId: string,
    userId: string | undefined,
    label: string,
    chainId?: number,
  ) {
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

    // Resolve chain ID — default to Ethereum mainnet if not provided
    const resolvedChainId = chainId ?? 1;

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
      chain_id: resolvedChainId,
    });

    await this.auditLogRepo.create({
      org_id: orgId,
      user_id: userId,
      wallet_id: wallet.id,
      event: 'wallet_created',
      status: 'success',
    });

    return { walletId: wallet.id, address };
  }

  async listWalletsByOrgId(orgId: string) {
    const wallets = await this.walletRepo.findByOrgId(orgId);
    return wallets.map((w) => ({
      id: w.id,
      orgId: w.org_id,
      userId: w.user_id,
      label: w.label,
      address: w.address,
      chainId: w.chain_id,
      status: w.status,
      createdAt: w.created_at,
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
      orgId: wallet.org_id,
      userId: wallet.user_id,
      label: wallet.label,
      address: wallet.address,
      chainId: wallet.chain_id,
      status: wallet.status,
      createdAt: wallet.created_at,
    };
  }

  async listSigningRequestsByOrgId(orgId: string) {
    const requests = await this.signingRequestRepo.findByOrgId(orgId);
    return requests.map(this.mapSigningRequest);
  }

  async listSigningRequestsByWalletId(walletId: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
    const requests = await this.signingRequestRepo.findByWalletId(walletId);
    return requests.map(this.mapSigningRequest);
  }

  private mapSigningRequest(request: any) {
    return {
      id: request.id,
      orgId: request.org_id,
      walletId: request.wallet_id,
      chainId: request.chain_id,
      txHash: request.tx_hash || '',
      txPayload: request.tx_payload,
      signature: request.signature || '',
      status: request.status,
      failureReason: request.failure_reason || undefined,
      errorType: request.error_type || undefined,
      policyResult: request.policy_result,
      blockNumber: request.block_number,
      gasUsed: request.gas_used,
      effectiveGasPrice: request.effective_gas_price,
      idempotencyKey: request.idempotency_key,
      createdAt: request.created_at,
      signedAt: request.signed_at,
      broadcastedAt: request.broadcasted_at,
      confirmedAt: request.confirmed_at,
    };
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

    // 2. Idempotency — the unique index on signing_requests.idempotency_key
    // is the arbiter. Fast-path check avoids burning a nonce on a duplicate.
    const idempotencyKey = this.computeIdempotencyKey(walletId, req);
    const existingRequest =
      await this.signingRequestRepo.findByIdempotencyKey(idempotencyKey);

    if (existingRequest && existingRequest.status !== 'failed') {
      this.logger.log(
        `Returning existing signing request ${existingRequest.id} for idempotency key ${idempotencyKey}`,
      );
      return this.buildSignResultFromRequest(existingRequest);
    }

    // 3. Policy evaluation - BEFORE nonce reservation to avoid wasting nonces
    const txPayload = {
      to: req.to,
      value: req.value,
      chainId: req.chainId,
    };
    const policyResult = await this.policyService.evaluate(
      orgId,
      walletId,
      txPayload,
    );
    if (policyResult.decision === 'deny') {
      throw new ForbiddenException(`Policy denied: ${policyResult.reason}`);
    }

    // 4. Estimate fees if not provided by caller
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

    // 5. Atomically reserve (consume) the next nonce. The reservation is
    // permanent — concurrent requests can never observe the same nonce.
    const nonce = await this.gasService.reserveNonce(walletId, req.chainId);

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

    // 6. Create the pending signing_request. The idempotency_key unique index
    // arbitrates concurrent duplicate submissions: the loser of the race
    // either returns the winner's request or reuses a previously failed row.
    let signingRequest;
    try {
      signingRequest = await this.signingRequestRepo.create({
        org_id: orgId,
        wallet_id: walletId,
        chain_id: req.chainId,
        tx_payload: JSON.parse(JSON.stringify(txFields)),
        status: 'pending',
        idempotency_key: idempotencyKey,
      });
    } catch (err) {
      const pgErr = err as { code?: string } | undefined;
      if (pgErr?.code !== '23505') throw err; // not a uniqueness conflict

      const raced =
        await this.signingRequestRepo.findByIdempotencyKey(idempotencyKey);
      if (raced && raced.status !== 'failed') {
        this.logger.log(
          `Concurrent duplicate detected; returning existing signing request ${raced.id}`,
        );
        return this.buildSignResultFromRequest(raced);
      }
      if (!raced) throw err; // uniqueness violation with no matching row — unexpected

      // Reuse the failed row: reset to pending so the retry can proceed.
      this.logger.log(
        `Reusing previously failed signing request ${raced.id} for idempotency key ${idempotencyKey}`,
      );
      await this.signingRequestRepo.update(raced.id, {
        status: 'pending',
        tx_payload: JSON.parse(JSON.stringify(txFields)),
        tx_hash: undefined,
        signature: undefined,
        failure_reason: undefined,
        error_type: undefined,
      });
      signingRequest = { ...raced, status: 'pending', tx_payload: txFields };
    }

    // 7. Sign via Go sidecar
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
      // Log the full detail server-side; never surface crypto/RPC internals
      // to the client.
      this.logger.error(
        `Sign failed for signing request ${signingRequest.id}: ${(err as Error).message}`,
      );
      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'failed',
        failure_reason: (err as Error).message,
        error_type: errorType,
      });
      throw new HttpException(
        `Transaction signing failed (${errorType})`,
        errorType === 'permanent'
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 8. Update signing_request with hash + signature
    await this.signingRequestRepo.update(signingRequest.id, {
      tx_hash: signResult.txHash,
      signature: signResult.signature,
      status: 'signed',
      signed_at: new Date(),
    });

    // 9. Broadcast with retry
    try {
      await this.gasService.broadcastTransaction(signResult.rawTx, req.chainId);

      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'broadcasted',
        broadcasted_at: new Date(),
      });
    } catch (err) {
      const errorType = classifyError(err as Error);
      this.logger.error(
        `Broadcast failed for signing request ${signingRequest.id}: ${(err as Error).message}`,
      );
      await this.signingRequestRepo.update(signingRequest.id, {
        status: 'failed',
        failure_reason: `broadcast failed: ${(err as Error).message}`,
        error_type: errorType,
      });
      throw new HttpException(
        `Transaction broadcast failed (${errorType})`,
        errorType === 'permanent'
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 10. Poll for receipt. (The nonce was consumed at reservation time —
    // there is no post-broadcast increment step.)
    const { receipt, timedOut } = await this.gasService.waitForReceipt(
      signResult.txHash,
      req.chainId,
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
