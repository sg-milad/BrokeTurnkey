import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateWalletResponse,
  DeriveWalletResponse,
  SignTransactionResult,
  TxFields,
} from './interfaces/crypto-client.interfaces';

@Injectable()
export class CryptoClientService implements OnModuleInit {
  private readonly logger = new Logger(CryptoClientService.name);
  private baseUrl!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.baseUrl = this.config.getOrThrow<string>('CRYPTO_SERVICE_URL');
    this.logger.log(`Crypto service URL: ${this.baseUrl}`);
  }

  async createWallet(): Promise<CreateWalletResponse> {
    return this.post<CreateWalletResponse>('/wallet/create', {});
  }

  async deriveWallet(
    encryptedSeed: string,
    seedNonce: string,
    encryptedDek: string,
    derivIndex: number,
  ): Promise<DeriveWalletResponse> {
    return this.post<DeriveWalletResponse>('/wallet/derive', {
      encryptedSeed,
      seedNonce,
      encryptedDek,
      derivIndex,
    });
  }

  async signTransaction(
    encryptedSeed: string,
    seedNonce: string,
    encryptedDek: string,
    derivationPath: string,
    txFields: TxFields,
  ): Promise<SignTransactionResult> {
    return this.post('/wallet/sign', {
      encryptedSeed,
      seedNonce,
      encryptedDek,
      derivationPath,
      txFields,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(no body)');
      throw new Error(
        `Crypto service ${path} failed [${response.status}]: ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }
}
