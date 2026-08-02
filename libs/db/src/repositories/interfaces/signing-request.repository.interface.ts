import {
  SigningRequest,
  NewSigningRequest,
} from '../../schema/signing-requests';

interface SigningRequestUpdate {
  tx_hash?: string;
  signature?: string;
  status?: string;
  failure_reason?: string;
  error_type?: string;
  block_number?: number | null;
  gas_used?: string | null;
  effective_gas_price?: string | null;
  signed_at?: Date;
  broadcasted_at?: Date;
  confirmed_at?: Date;
}

export interface ISigningRequestRepository {
  findById(id: string): Promise<SigningRequest | undefined>;
  findByIdempotencyKey(key: string): Promise<SigningRequest | undefined>;
  findByOrgId(orgId: string): Promise<SigningRequest[]>;
  findByWalletId(walletId: string): Promise<SigningRequest[]>;
  create(data: NewSigningRequest): Promise<SigningRequest>;
  update(id: string, fields: SigningRequestUpdate): Promise<void>;
}
