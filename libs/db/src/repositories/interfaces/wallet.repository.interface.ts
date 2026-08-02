import { Wallet, NewWallet } from '../../schema/wallets';

export interface IWalletRepository {
  findByOrgId(orgId: string): Promise<Wallet[]>;
  findById(id: string): Promise<Wallet | undefined>;
  countByOrgId(orgId: string): Promise<number>;
  create(data: NewWallet): Promise<Wallet>;
}
