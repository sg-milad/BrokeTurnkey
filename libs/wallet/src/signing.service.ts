import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashTypedData, hashMessage } from 'viem';
import type { TypedDataDefinition } from 'viem';
import { CryptoClientService } from '@app/crypto-client';
import {
  organizationSeedRepository,
  WalletRepository,
  AuditLogRepository,
} from '@app/db/repositories';
import type {
  Eip712SignRequest,
  PersonalMessageSignRequest,
  TypedSignResult,
} from './signing.interfaces';

@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name);

  constructor(
    private readonly cryptoClient: CryptoClientService,
    private readonly orgSeedRepo: organizationSeedRepository,
    private readonly walletRepo: WalletRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sign EIP-712 typed data. Constructs the hash using viem's hashTypedData,
   * then delegates to the Go sidecar for raw secp256k1 signing.
   *
   * sign-hash is an unrestricted signing oracle by design (the Go service
   * signs whatever 32-byte hash it is given), so NestJS gates the surface:
   * the EIP-712 domain must be on the configured allowlist before a hash is
   * ever produced. Configure EIP712_DOMAIN_ALLOWLIST as a comma-separated
   * list of allowed domain names; empty means "allow all" (default).
   */
  async signEip712(
    orgId: string,
    walletId: string,
    req: Eip712SignRequest,
  ): Promise<TypedSignResult> {
    const { seedRow, wallet } = await this.loadWallet(orgId, walletId);

    const allowlist = this.getDomainAllowlist();
    if (allowlist.length > 0) {
      const domainName = (req.domain as Record<string, unknown> | undefined)
        ?.name as string | undefined;
      if (!domainName || !allowlist.includes(domainName)) {
        throw new ForbiddenException(
          `EIP-712 domain "${domainName ?? '(none)'}" is not allowlisted`,
        );
      }
    }

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

  private getDomainAllowlist(): string[] {
    const raw = this.config.get<string>('EIP712_DOMAIN_ALLOWLIST') ?? '';
    return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  }
}
