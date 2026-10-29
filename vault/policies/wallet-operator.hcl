# Operator-only policy for rotating the crypto sidecar's AppRole SecretID.
# Attach this to a human/admin token, never to wallet-signer.

path "auth/approle/role/wallet-signer/secret-id" {
  capabilities = ["update"]
}

path "auth/approle/role/wallet-signer/secret-id-accessor/*" {
  capabilities = ["update"]
}

path "auth/approle/role/wallet-signer" {
  capabilities = ["read"]
}
