import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { hashTypedData, hashMessage } from 'viem';
import type { TypedDataDefinition } from 'viem';
import { CryptoClientService } from '@app/crypto-client';
import {
  organizationSeedRepository,
  WalletRepository,
  AuditLogRepository,
} from '@app/db/repositories';

export interface Eip712SignRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PersonalMessageSignRequest {
  message: string; // UTF-8 string or 0x-prefixed hex
}

export interface TypedSignResult {
  signature: string; // 0x-prefixed 65-byte hex
  hash: string; // 0x-prefixed 32-byte hex of the hash that was signed
}

@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name);

  constructor(
    private readonly cryptoClient: CryptoClientService,
    private readonly orgSeedRepo: organizationSeedRepository,
    private readonly walletRepo: WalletRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  /**
   * Sign EIP-712 typed data. Constructs the hash using viem's hashTypedData,
   * then delegates to the Go sidecar for raw secp256k1 signing.
   */
  async signEip712(
    orgId: string,
    walletId: string,
    req: Eip712SignRequest,
  ): Promise<TypedSignResult> {
    const { seedRow, wallet } = await this.loadWallet(orgId, walletId);

    // Construct the EIP-712 hash in NestJS — Go is schema-unaware
    const hash = hashTypedData({
      domain: req.domain,
      types: req.types,
      primaryType: req.primaryType,
      message: req.message,
    } as unknown as TypedDataDefinition);

    this.logger.log(
      `Signing EIP-712 typed data for wallet ${walletId}, hash: ${hash}`,
    );

    const result = await this.cryptoClient.signHash(
      seedRow.encrypted_seed,
      seedRow.seed_nonce,
      seedRow.encrypted_dek,
      wallet.derivation_path,
      hash,
    );

    await this.auditLogRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      event: 'typed_data_signed',
      status: 'success',
      metadata: {
        primaryType: req.primaryType,
        hash,
        signature: result.signature,
      },
    });

    return {
      signature: result.signature,
      hash,
    };
  }

  /**
   * Sign a personal message (EIP-191). Constructs the prefixed hash using
   * viem's hashMessage, then delegates to the Go sidecar.
   */
  async signPersonalMessage(
    orgId: string,
    walletId: string,
    req: PersonalMessageSignRequest,
  ): Promise<TypedSignResult> {
    const { seedRow, wallet } = await this.loadWallet(orgId, walletId);

    // Construct the personal sign hash in NestJS
    const hash = hashMessage(req.message);

    this.logger.log(
      `Signing personal message for wallet ${walletId}, hash: ${hash}`,
    );

    const result = await this.cryptoClient.signHash(
      seedRow.encrypted_seed,
      seedRow.seed_nonce,
      seedRow.encrypted_dek,
      wallet.derivation_path,
      hash,
    );

    await this.auditLogRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      event: 'message_signed',
      status: 'success',
      metadata: {
        hash,
        signature: result.signature,
      },
    });

    return {
      signature: result.signature,
      hash,
    };
  }

  private async loadWallet(orgId: string, walletId: string) {
    const [seedRow, wallet] = await Promise.all([
      this.orgSeedRepo.findByOrgId(orgId),
      this.walletRepo.findById(walletId),
    ]);

    if (!seedRow)
      throw new BadRequestException('Organization has not been onboarded');
    if (!wallet) throw new NotFoundException(`Wallet "${walletId}" not found`);
    if (wallet.org_id !== orgId)
      throw new BadRequestException('Wallet does not belong to this org');

    return { seedRow, wallet };
  }
}
