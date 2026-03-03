import * as crypto from 'crypto';

export function generateDkimKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
    },
  });

  // Format the public key for DNS (remove headers and newlines)
  const formattedPublic = publicKey.replace(
    /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n|\r/g,
    '',
  );

  return { publicKey: formattedPublic, privateKey };
}
