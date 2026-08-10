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
  signingRequestId: string;
  txHash: string;
  status: string;
  nonce: number;
  idempotencyKey: string;
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

  async getWalletById(walletId: string, orgId: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
    if (wallet.org_id !== orgId)
      throw new BadRequestException('Wallet does not belong to this org');
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

  async listSigningRequestsByWalletId(walletId: string, orgId: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
    if (wallet.org_id !== orgId)
      throw new BadRequestException('Wallet does not belong to this org');
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

    // 5. Create the pending signing_request before reserving a nonce.
    // This prevents races where duplicate requests both reserve a nonce and
    // waste one before the idempotency constraint can fail the second request.
    let signingRequest;
    try {
      signingRequest = await this.signingRequestRepo.create({
        org_id: orgId,
        wallet_id: walletId,
        chain_id: req.chainId,
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
        tx_payload: undefined,
        tx_hash: undefined,
        signature: undefined,
        failure_reason: undefined,
        error_type: undefined,
      });
      signingRequest = { ...raced, status: 'pending', tx_payload: undefined };
    }

    // 6. Atomically reserve (consume) the next nonce. The reservation is
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

    await this.signingRequestRepo.update(signingRequest.id, {
      tx_payload: JSON.parse(JSON.stringify(txFields)),
    });

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
      this.logger.log(
        `signResult.rawTx length: ${signResult.rawTx?.length}, value: ${signResult.rawTx?.substring(0, 20)}`,
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
      // A signer failure happens before a raw transaction can reach the RPC.
      // Reclaim only the sequence tail; concurrent reservations remain safe.
      await this.gasService.releaseNonce(walletId, req.chainId, nonce);
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
      this.logger.log(`Broadcast completed for txHash: ${signResult.txHash}`);
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

      // Sync nonce — the reserved nonce was never used on-chain
      this.gasService
        .syncNonce(walletId, req.chainId, wallet.address)
        .catch((err) =>
          this.logger.warn(
            `Nonce sync after broadcast failure: ${(err as Error).message}`,
          ),
        );

      throw new HttpException(
        `Transaction broadcast failed (${errorType})`,
        errorType === 'permanent'
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 10. Fire-and-forget: TransactionMonitorService (@app/monitor) owns
    // everything after broadcast — confirmation, stuck detection, speed-up,
    // and drop detection. See docs/TASKS.md Phase 9.
    await this.auditLogRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      event: 'tx_signed',
      status: 'broadcasted',
      metadata: {
        txHash: signResult.txHash,
        signingRequestId: signingRequest.id,
        chainId: req.chainId,
      },
    });

    // 11. Return immediately — do not block on waitForReceipt.
    return {
      signingRequestId: signingRequest.id,
      txHash: signResult.txHash,
      status: 'broadcasted',
      nonce,
      idempotencyKey,
    };
  }

  /**
   * Returns the current status of a single signing request. Used by clients
   * to poll after receiving `broadcasted` from POST /wallets/:id/sign.
   */
  async getSigningRequestById(
    orgId: string,
    walletId: string,
    requestId: string,
  ) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet)
      throw new NotFoundException(
        `Wallet with id "${walletId}" does not exist`,
      );
    if (wallet.org_id !== orgId)
      throw new BadRequestException('Wallet does not belong to this org');

    const request = await this.signingRequestRepo.findById(requestId);
    if (!request)
      throw new NotFoundException(
        `Signing request with id "${requestId}" does not exist`,
      );
    if (request.wallet_id !== walletId)
      throw new BadRequestException(
        'Signing request does not belong to this wallet',
      );

    return this.mapSigningRequest(request);
  }

  private computeIdempotencyKey(walletId: string, req: SignRequest): string {
    const payload = `${walletId}:${req.chainId}:${req.to}:${req.value}:${req.data}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  private buildSignResultFromRequest(request: any): SignResult {
    return {
      signingRequestId: request.id,
      txHash: request.tx_hash || '',
      status: request.status,
      nonce: request.tx_payload?.nonce ?? 0,
      idempotencyKey: request.idempotency_key,
      errorType: request.error_type as ErrorType | undefined,
      errorMessage: request.failure_reason || undefined,
    };
  }
}
