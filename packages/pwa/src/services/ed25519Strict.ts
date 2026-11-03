/**
 * Ed25519 點與簽章的嚴格檢查（群組狀態鏈用；審查 H1／M2，2026-10-22）—— 純函式，只處理公開資料（可以用 BigInt）。
 *
 * 為什麼：每台成員對同一筆 commit 要得到同一個答案，不能取決於呼叫端注入的驗章器是寬鬆的（ed25519-dalek `verify`）、
 * 嚴格的（`verify_strict`）還是 cofactored（ZIP-215）。下面兩件事都成立時，這幾種驗章器的結果一定一樣：
 *   1. 公鑰 A 與簽章的 R 都是正規編碼（y < p；x = 0 時正負號位元是 0）、在曲線上、不是恆等點，
 *      而且在質數階子群裡（[L]P = 恆等點）—— 小階點、混了小階成分的點（mixed-order）都不是
 *   2. S 是正規的純量（S < L）
 * （A、R 都在質數階子群時 [S]B − [k]A − R 也在子群裡，乘不乘 8 判斷都一樣；R 是正規編碼時，比位元組與比點也一樣。）
 * 成員公鑰還多一個理由（審查 H1）：新金鑰要封給每位成員（轉成 X25519）；不在曲線上的 32 bytes 會讓封裝失敗。
 * 速度：一次 [L]P 約 1 ms（BigInt），只做在進名冊的公鑰、genesis 的建立者、每個簽章的 R 上。
 */

const P = (1n << 255n) - 19n;
const M255 = (1n << 255n) - 1n;
/** 曲線參數 d = −121665/121666 mod p */
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const D2 = (2n * D) % P;
const P4 = 4n * P;
/** 質數階子群的階 L = 2^252 + 27742317777372353535851937790883648493 */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const L_BITS = ED25519_L.toString(2);

/** mod p：p = 2^255 − 19 的快速折疊（輸入非負、最多約 520 bits） */
function red(x: bigint): bigint {
  let r = (x & M255) + 19n * (x >> 255n);
  r = (r & M255) + 19n * (r >> 255n);
  return r >= P ? r - P : r;
}

function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = red(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = red(result * b);
    b = red(b * b);
    e >>= 1n;
  }
  return result;
}

const SQRT_M1 = powMod(2n, (P - 1n) / 4n);

function leToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** 擴展座標 (X, Y, Z, T)：x = X/Z、y = Y/Z、xy = T/Z；每個座標都已經 mod p */
type Point = readonly [bigint, bigint, bigint, bigint];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

/** a = −1 的扭曲 Edwards 曲線加法（add-2008-hwcd-3） */
function add([X1, Y1, Z1, T1]: Point, [X2, Y2, Z2, T2]: Point): Point {
  const A = red((Y1 - X1 + P4) * (Y2 - X2 + P4));
  const B = red((Y1 + X1) * (Y2 + X2));
  const C = red(red(T1 * D2) * T2);
  const Dd = red(2n * Z1 * Z2);
  const E = B - A + P4;
  const F = Dd - C + P4;
  const G = Dd + C;
  const H = B + A;
  return [red(E * F), red(G * H), red(F * G), red(E * H)];
}

/** 倍點（dbl-2008-hwcd，a = −1） */
function dbl([X1, Y1, Z1]: Point): Point {
  const A = red(X1 * X1);
  const B = red(Y1 * Y1);
  const C = red(2n * Z1 * Z1);
  const s = X1 + Y1;
  const H = A + B;
  const E = H - red(s * s) + P4;
  const G = A - B + P4;
  const F = C + G;
  return [red(E * F), red(G * H), red(F * G), red(E * H)];
}

const isIdentity = ([X, Y, Z]: Point): boolean => X === 0n && Y === Z;

function timesL(p: Point): Point {
  let r = IDENTITY;
  for (const bit of L_BITS) {
    r = dbl(r);
    if (bit === '1') r = add(r, p);
  }
  return r;
}

/** RFC 8032 §5.1.3 解壓縮；非正規編碼、不在曲線上、x = 0 卻帶負號 → null */
function decompress(bytes: Uint8Array): Point | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
  const sign = bytes[31] >> 7;
  const yBytes = Uint8Array.from(bytes);
  yBytes[31] &= 0x7f;
  const y = leToBig(yBytes);
  if (y >= P) return null;
  const y2 = red(y * y);
  const u = red(y2 + P - 1n);
  const v = red(D * y2 + 1n);
  // x = u·v³·(u·v⁷)^((p−5)/8)
  const v3 = red(red(v * v) * v);
  const uv3 = red(u * v3);
  let x = red(uv3 * powMod(red(uv3 * red(v3 * v)), (P - 5n) / 8n));
  const vx2 = red(red(v * x) * x);
  if (vx2 !== u) {
    if (vx2 !== red(P - u)) return null;
    x = red(x * SQRT_M1);
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, red(x * y)];
}

/** 32 bytes 是正規編碼、在曲線上、不是恆等點、而且在質數階子群裡的 Ed25519 點（不是小階點、沒有小階成分） */
export function isPrimeOrderPoint(bytes: Uint8Array): boolean {
  const p = decompress(bytes);
  return p !== null && !isIdentity(p) && isIdentity(timesL(p));
}

/** 64 bytes 簽章 R ‖ S：S < L，R 是質數階子群裡的正規點（不看內容對不對，那是驗章器的事） */
export function isStrictSignature(sig: Uint8Array): boolean {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  return leToBig(sig.subarray(32, 64)) < ED25519_L && isPrimeOrderPoint(sig.subarray(0, 32));
}
