import { SigningRequest, NewSigningRequest } from '../../schema/signing-requests';

export interface ISigningRequestRepository {
    findById(id: string): Promise<SigningRequest | undefined>;
    create(data: NewSigningRequest): Promise<SigningRequest>;
}