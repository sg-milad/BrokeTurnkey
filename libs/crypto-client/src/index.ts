export * from './crypto-client.module';
export * from './crypto-client.service';

export { CryptoClientModule } from './crypto-client.module';
export { CryptoClientService } from './crypto-client.service';
export type {
    TxFields,
    CreateWalletResponse,
    DeriveWalletResponse,
    SignTransactionResponse,
} from './interfaces/crypto-client.interfaces';