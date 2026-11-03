//! 金鑰管理模組
//!
//! 提供 X25519 (金鑰交換) 和 Ed25519 (簽章) 金鑰對的生成與管理

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519SecretKey};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::rngs::OsRng;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// 身份金鑰對 (Ed25519)
/// 用於簽章和身份驗證，長期使用
#[wasm_bindgen]
#[derive(Clone)]
pub struct IdentityKeyPair {
    signing_key: SigningKey,
}

#[wasm_bindgen]
impl IdentityKeyPair {
    /// 生成新的身份金鑰對
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        Self { signing_key }
    }

    /// 從私鑰位元組還原
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<IdentityKeyPair, JsError> {
        if bytes.len() != 32 {
            return Err(JsError::new("Private key must be 32 bytes"));
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(bytes);
        let signing_key = SigningKey::from_bytes(&key_bytes);
        Ok(Self { signing_key })
    }

    /// 取得公鑰 (Base64)
    #[wasm_bindgen(js_name = publicKeyBase64)]
    pub fn public_key_base64(&self) -> String {
        BASE64.encode(self.signing_key.verifying_key().as_bytes())
    }

    /// 取得公鑰位元組
    #[wasm_bindgen(js_name = publicKeyBytes)]
    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.signing_key.verifying_key().as_bytes().to_vec()
    }

    /// 取得私鑰位元組 (敏感！僅用於備份)
    #[wasm_bindgen(js_name = privateKeyBytes)]
    pub fn private_key_bytes(&self) -> Vec<u8> {
        self.signing_key.to_bytes().to_vec()
    }

    /// 簽署訊息
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.signing_key.sign(message).to_bytes().to_vec()
    }

    /// 驗證簽章
    #[wasm_bindgen(js_name = verifySignature)]
    pub fn verify_signature(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
        if public_key.len() != 32 || signature.len() != 64 {
            return false;
        }

        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(public_key);

        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(signature);

        let verifying_key = match VerifyingKey::from_bytes(&pk_bytes) {
            Ok(k) => k,
            Err(_) => return false,
        };

        let signature = Signature::from_bytes(&sig_bytes);
        verifying_key.verify(message, &signature).is_ok()
    }
}

impl Default for IdentityKeyPair {
    fn default() -> Self {
        Self::new()
    }
}

/// X25519 金鑰對
/// 用於 Diffie-Hellman 金鑰交換
#[wasm_bindgen]
pub struct X25519KeyPair {
    secret: X25519SecretKey,
    public: X25519PublicKey,
}

#[wasm_bindgen]
impl X25519KeyPair {
    /// 生成新的 X25519 金鑰對
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let secret = X25519SecretKey::random_from_rng(OsRng);
        let public = X25519PublicKey::from(&secret);
        Self { secret, public }
    }

    /// 從私鑰位元組還原
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<X25519KeyPair, JsError> {
        if bytes.len() != 32 {
            return Err(JsError::new("Private key must be 32 bytes"));
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(bytes);
        let secret = X25519SecretKey::from(key_bytes);
        let public = X25519PublicKey::from(&secret);
        Ok(Self { secret, public })
    }

    /// 取得公鑰 (Base64)
    #[wasm_bindgen(js_name = publicKeyBase64)]
    pub fn public_key_base64(&self) -> String {
        BASE64.encode(self.public.as_bytes())
    }

    /// 取得公鑰位元組
    #[wasm_bindgen(js_name = publicKeyBytes)]
    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.public.as_bytes().to_vec()
    }

    /// 取得私鑰位元組 (敏感！)
    #[wasm_bindgen(js_name = privateKeyBytes)]
    pub fn private_key_bytes(&self) -> Vec<u8> {
        self.secret.to_bytes().to_vec()
    }

    /// 執行 Diffie-Hellman 金鑰交換
    #[wasm_bindgen(js_name = diffieHellman)]
    pub fn diffie_hellman(&self, their_public: &[u8]) -> Result<Vec<u8>, JsError> {
        if their_public.len() != 32 {
            return Err(JsError::new("Public key must be 32 bytes"));
        }
        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(their_public);
        let their_public = X25519PublicKey::from(pk_bytes);
        let shared = self.secret.diffie_hellman(&their_public);
        Ok(shared.as_bytes().to_vec())
    }
}

impl Default for X25519KeyPair {
    fn default() -> Self {
        Self::new()
    }
}

/// 預簽署金鑰 (Signed PreKey)
/// 中期使用的 X25519 金鑰，附帶身份金鑰簽章
#[derive(Serialize, Deserialize, Clone)]
pub struct SignedPreKey {
    pub key_id: u32,
    pub public_key: Vec<u8>,
    pub signature: Vec<u8>,
    pub timestamp: u64,
}

/// 一次性預金鑰 (One-Time PreKey)
/// 用完即丟的 X25519 金鑰
#[derive(Serialize, Deserialize, Clone)]
pub struct OneTimePreKey {
    pub key_id: u32,
    pub public_key: Vec<u8>,
}

/// 金鑰組合 (用於公開發布)
/// 通過 JSON 序列化傳遞給 JavaScript
#[derive(Serialize, Deserialize, Clone)]
pub struct PreKeyBundle {
    /// 身份公鑰 (Ed25519)
    pub identity_key: Vec<u8>,
    /// 簽署過的預金鑰
    pub signed_pre_key: SignedPreKey,
    /// 一次性預金鑰 (可選)
    pub one_time_pre_key: Option<OneTimePreKey>,
}

impl PreKeyBundle {
    /// 建立新的 PreKeyBundle
    pub fn new(
        identity_key: Vec<u8>,
        signed_pre_key: SignedPreKey,
        one_time_pre_key: Option<OneTimePreKey>,
    ) -> Self {
        Self {
            identity_key,
            signed_pre_key,
            one_time_pre_key,
        }
    }

    /// 序列化為 JSON
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    /// 從 JSON 還原
    pub fn from_json(json: &str) -> Result<PreKeyBundle, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }

    /// 取得身份公鑰 (Base64)
    pub fn identity_key_base64(&self) -> String {
        BASE64.encode(&self.identity_key)
    }
}

/// WASM 輔助函式：建立 PreKeyBundle JSON
#[wasm_bindgen(js_name = createPreKeyBundleJson)]
pub fn create_pre_key_bundle_json(
    identity_key: &[u8],
    signed_pre_key_id: u32,
    signed_pre_key_public: &[u8],
    signed_pre_key_signature: &[u8],
    signed_pre_key_timestamp: u64,
    one_time_pre_key_id: Option<u32>,
    one_time_pre_key_public: Option<Vec<u8>>,
) -> Result<String, JsError> {
    let signed_pre_key = SignedPreKey {
        key_id: signed_pre_key_id,
        public_key: signed_pre_key_public.to_vec(),
        signature: signed_pre_key_signature.to_vec(),
        timestamp: signed_pre_key_timestamp,
    };

    let one_time_pre_key = match (one_time_pre_key_id, one_time_pre_key_public) {
        (Some(id), Some(pk)) => Some(OneTimePreKey {
            key_id: id,
            public_key: pk,
        }),
        _ => None,
    };

    let bundle = PreKeyBundle::new(identity_key.to_vec(), signed_pre_key, one_time_pre_key);
    bundle.to_json().map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identity_keypair() {
        let keypair = IdentityKeyPair::new();
        let message = b"test message";
        let signature = keypair.sign(message);

        assert!(IdentityKeyPair::verify_signature(
            &keypair.public_key_bytes(),
            message,
            &signature
        ));
    }

    #[test]
    fn test_x25519_dh() {
        let alice = X25519KeyPair::new();
        let bob = X25519KeyPair::new();

        let alice_shared = alice.diffie_hellman(&bob.public_key_bytes()).unwrap();
        let bob_shared = bob.diffie_hellman(&alice.public_key_bytes()).unwrap();

        assert_eq!(alice_shared, bob_shared);
    }
}
