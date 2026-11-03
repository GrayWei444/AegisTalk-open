use wasm_bindgen::prelude::*;

pub mod crypto;
pub mod storage;
pub mod network;

// 重新導出常用類型供 WASM 使用
pub use crypto::{
    IdentityKeyPair,
    X25519KeyPair,
    X3DH,
    X3DHSenderOutput,
    X3DHInitialMessage,
    RatchetSession,
    RatchetMessage,
    AesGcmCipher,
    EncryptedMessage,
    aes_encrypt,
    aes_decrypt,
    aes_decrypt_bytes,
    sign_pre_key,
    create_pre_key_bundle_json,
};

#[wasm_bindgen(start)]
pub fn init() {
    // 設定 panic hook 以便在瀏覽器 console 顯示錯誤
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 生成隨機位元組
#[wasm_bindgen(js_name = randomBytes)]
pub fn random_bytes(len: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// Base64 編碼
#[wasm_bindgen(js_name = base64Encode)]
pub fn base64_encode(data: &[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    STANDARD.encode(data)
}

/// Base64 解碼
#[wasm_bindgen(js_name = base64Decode)]
pub fn base64_decode(data: &str) -> Result<Vec<u8>, JsError> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    STANDARD.decode(data).map_err(|e| JsError::new(&e.to_string()))
}
