#!/usr/bin/env node
const { generateKeyPairSync, createHash, createSign } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');

function usage() {
  console.log(`Usage:
  node scripts/stamp-helper.js generate-keypair <private.pem> <public.pem>
  node scripts/stamp-helper.js make-stamp <key_id> <private.pem> <body-file>

Examples:
  node scripts/stamp-helper.js generate-keypair ./private.pem ./public.pem
  node scripts/stamp-helper.js make-stamp 2e876946-663e-4aa1-b931-57594effa899 ./private.pem ./payload.json

For GET requests with no body, use an empty file:
  printf '' > /tmp/empty.json
  node scripts/stamp-helper.js make-stamp <key_id> ./private.pem /tmp/empty.json
`);
}

function generateKeypair(privateOut, publicOut) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  writeFileSync(privateOut, privateKey, 'utf8');
  writeFileSync(publicOut, publicKey, 'utf8');
  console.log(`Wrote private key to ${privateOut}`);
  console.log(`Wrote public key to ${publicOut}`);
}

function makeStamp(keyId, privateKeyPath, bodyPath) {
  const rawBody = readFileSync(bodyPath);
  const timestamp = `${Date.now()}`;
  const bodyHash = createHash('sha256').update(rawBody).digest('base64url');
  const payload = `${timestamp}.${bodyHash}`;
  const signature = createSign('sha256')
    .update(payload)
    .end()
    .sign({ key: readFileSync(privateKeyPath, 'utf8'), dsaEncoding: 'der' });
  process.stdout.write(
    `${signature.toString('base64url')}.${timestamp}.${keyId}`,
  );
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'generate-keypair') {
    if (args.length !== 2) {
      usage();
      process.exit(1);
    }
    generateKeypair(args[0], args[1]);
    return;
  }

  if (command === 'make-stamp') {
    if (args.length !== 3) {
      usage();
      process.exit(1);
    }
    makeStamp(args[0], args[1], args[2]);
    return;
  }

  usage();
  process.exit(1);
}

main();
