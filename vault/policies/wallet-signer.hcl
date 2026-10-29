# Runtime policy for the crypto sidecar's AppRole.
# Deliberately excludes auth/approle/role/wallet-signer/secret-id: a process
# that can read the runtime policy must not be able to mint new SecretIDs.
path "transit/encrypt/wallet-dek" {
  capabilities = ["update"]
}

path "transit/decrypt/wallet-dek" {
  capabilities = ["update"]
}
