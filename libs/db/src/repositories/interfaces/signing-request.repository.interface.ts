import { SigningRequest, NewSigningRequest } from '../../schema/signing-requests';

export interface ISigningRequestRepository {
    findById(id: string): Promise<SigningRequest | undefined>;
    findByOrgId(orgId: string): Promise<SigningRequest[]>;
    findByWalletId(walletId: string): Promise<SigningRequest[]>;
    create(data: NewSigningRequest): Promise<SigningRequest>;
}
