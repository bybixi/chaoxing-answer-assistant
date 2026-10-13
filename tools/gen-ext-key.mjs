/**
 * 生成固定的扩展公钥（manifest.key），让扩展 ID 与加载路径解耦。
 * 私钥写入 .keys/ 目录，仅本机保存，将来要上架商店时用它保持 ID 不变。
 * node tools/gen-ext-key.mjs
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const keyB64 = Buffer.from(publicKey).toString('base64');

// Chrome 的扩展 ID 算法：公钥 DER 的 SHA256 前 32 位十六进制，映射 0-9a-f → a-p
const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

mkdirSync('.keys', { recursive: true });
writeFileSync('.keys/extension-private-key.pem', privateKey, 'utf8');
// 公钥写到 wxt.config.ts 会读取的位置，构建时自动写进 manifest.key
writeFileSync('.keys/public-key.txt', keyB64 + '\n', 'utf8');

console.log('MANIFEST_KEY=' + keyB64);
console.log('EXPECTED_ID=' + id);
console.log('\n✓ 私钥 → .keys/extension-private-key.pem');
console.log('✓ 公钥 → .keys/public-key.txt（下一次 npm run build 生效）');
console.log('  ⚠️ .keys/ 已 gitignore，请自行备份私钥（上架商店时要用同一个）。');
