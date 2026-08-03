import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateWalletResponse,
  DeriveWalletResponse,
  SignTransactionResult,
  SignHashResult,
  TxFields,
} from './interfaces/crypto-client.interfaces';

@Injectable()
export class CryptoClientService implements OnModuleInit {
  private readonly logger = new Logger(CryptoClientService.name);
  private baseUrl!: string;
  private authToken!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.baseUrl = this.config.getOrThrow<string>('CRYPTO_SERVICE_URL');
    // Shared secret with the Go crypto service — every request must carry it
    // or the crypto service rejects the call (fail closed on both sides).
    this.authToken = this.config.getOrThrow<string>('CRYPTO_AUTH_TOKEN');
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
    return this.post('/wallet/sign-transaction', {
      encryptedSeed,
      seedNonce,
      encryptedDek,
      derivationPath,
      txFields,
    });
  }

  async signHash(
    encryptedSeed: string,
    seedNonce: string,
    encryptedDek: string,
    derivationPath: string,
    hashHex: string,
  ): Promise<SignHashResult> {
    return this.post('/wallet/sign-hash', {
      encryptedSeed,
      seedNonce,
      encryptedDek,
      derivationPath,
      hashHex,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Crypto-Token': this.authToken,
      },
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
