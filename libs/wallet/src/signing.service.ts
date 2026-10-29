import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashTypedData, hashMessage, isAddress } from 'viem';
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
   * EIP-712 is a permit-style signing oracle if left open. NestJS requires
   * every dimension of the domain (name, chainId, verifyingContract) and the
   * primaryType to be explicitly allowlisted. Empty allowlists deny by default.
   */
  async signEip712(
    orgId: string,
    walletId: string,
    req: Eip712SignRequest,
  ): Promise<TypedSignResult> {
    this.assertEip712Allowed(req);

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
    if (!this.getBoolean('PERSONAL_MESSAGE_SIGNING_ENABLED', false)) {
      throw new ForbiddenException(
        'Personal message signing is disabled (PERSONAL_MESSAGE_SIGNING_ENABLED=false)',
      );
    }

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

  private getCsv(key: string): string[] {
    const raw = this.config.get<string>(key) ?? '';
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private getBoolean(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  }

  private assertEip712Allowed(req: Eip712SignRequest): void {
    const domain = req.domain ?? {};

    const domains = this.getCsv('EIP712_DOMAIN_ALLOWLIST');
    const domainName = typeof domain['name'] === 'string' ? domain['name'] : '';
    if (domains.length === 0 || !domainName || !domains.includes(domainName)) {
      throw new ForbiddenException(
        `EIP-712 domain "${domainName || '(none)'}" is not allowlisted`,
      );
    }

    const chainIds = this.getCsv('EIP712_ALLOWED_CHAIN_IDS')
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const rawChainId = domain['chainId'];
    const chainId =
      typeof rawChainId === 'number'
        ? rawChainId
        : typeof rawChainId === 'bigint'
          ? Number(rawChainId)
          : typeof rawChainId === 'string' && /^\d+$/.test(rawChainId)
            ? Number(rawChainId)
            : undefined;
    if (
      chainIds.length === 0 ||
      chainId === undefined ||
      !chainIds.includes(chainId)
    ) {
      throw new ForbiddenException(
        `EIP-712 chainId "${chainId ?? '(none)'}" is not allowlisted`,
      );
    }

    const contracts = this.getCsv('EIP712_ALLOWED_CONTRACTS').map((value) =>
      value.toLowerCase(),
    );
    const contract =
      typeof domain['verifyingContract'] === 'string'
        ? domain['verifyingContract'].toLowerCase()
        : '';
    if (
      contracts.length === 0 ||
      !contract ||
      !isAddress(contract) ||
      !contracts.includes(contract)
    ) {
      throw new ForbiddenException(
        `EIP-712 verifyingContract "${contract || '(none)'}" is not allowlisted`,
      );
    }

    const primaryTypes = this.getCsv('EIP712_ALLOWED_PRIMARY_TYPES');
    if (
      primaryTypes.length === 0 ||
      !req.primaryType ||
      !primaryTypes.includes(req.primaryType)
    ) {
      throw new ForbiddenException(
        `EIP-712 primaryType "${req.primaryType || '(none)'}" is not allowlisted`,
      );
    }
  }
}
