storage "file" {
  path = "/vault/data"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

ui            = true
disable_mlock = false
api_addr      = "http://0.0.0.0:8200"
