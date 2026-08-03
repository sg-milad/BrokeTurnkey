export interface Eip712SignRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PersonalMessageSignRequest {
  message: string; // UTF-8 string or 0x-prefixed hex
}

export interface TypedSignResult {
  signature: string; // 0x-prefixed 65-byte hex
  hash: string; // 0x-prefixed 32-byte hex of the hash that was signed
}
