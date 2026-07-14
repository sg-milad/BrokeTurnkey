import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiService {
  getHello(): string {
    return 'Hello World!';
  }

  async checkCryptoHealth(): Promise<{ status: string; crypto: string }> {
    const cryptoUrl = process.env.CRYPTO_SERVICE_URL || 'http://crypto:4000';
    try {
      const response = await fetch(`${cryptoUrl}/health`);
      if (response.ok) {
        return { status: 'ok', crypto: 'ok' };
      }
      return { status: 'error', crypto: `down (${response.status})` };
    } catch (error: any) {
      return { status: 'error', crypto: `unreachable (${error.message})` };
    }
  }
}
