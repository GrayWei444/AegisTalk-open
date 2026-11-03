/**
 * Safe ArrayBuffer extraction from Uint8Array.
 *
 * `Uint8Array.prototype.buffer` returns the *underlying* ArrayBuffer,
 * which may be larger than the view if the array is a subarray.
 * This helper slices to the exact byte range the view covers,
 * preventing subtle crypto bugs where extra bytes corrupt ciphertext/IV/keys.
 */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
