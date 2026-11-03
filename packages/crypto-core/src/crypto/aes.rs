//! AES-GCM 對稱加密模組
//!
//! 提供 AES-256-GCM 加密/解密功能

use wasm_bindgen::prelude::*;
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const NONCE_SIZE: usize = 12;
const KEY_SIZE: usize = 32;

/// 加密後的訊息結構
#[wasm_bindgen]
#[derive(Serialize, Deserialize, Clone)]
pub struct EncryptedMessage {
    /// 密文
    ciphertext: Vec<u8>,
    /// Nonce (12 bytes)
    nonce: Vec<u8>,
}

#[wasm_bindgen]
impl EncryptedMessage {
    /// 取得密文
    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }

    /// 取得 nonce
    #[wasm_bindgen(getter)]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }

    /// 合併為單一位元組陣列 (nonce || ciphertext)
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut result = self.nonce.clone();
        result.extend(&self.ciphertext);
        result
    }

    /// 從位元組陣列還原
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<EncryptedMessage, JsError> {
        if bytes.len() < NONCE_SIZE {
            return Err(JsError::new("Invalid encrypted message: too short"));
        }
        Ok(Self {
            nonce: bytes[..NONCE_SIZE].to_vec(),
            ciphertext: bytes[NONCE_SIZE..].to_vec(),
        })
    }

    /// 序列化為 JSON
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 從 JSON 還原
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<EncryptedMessage, JsError> {
        serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))
    }
}

/// AES-256-GCM 加密器
#[wasm_bindgen]
pub struct AesGcmCipher {
    cipher: Aes256Gcm,
}

#[wasm_bindgen]
impl AesGcmCipher {
    /// 從金鑰建立加密器
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> Result<AesGcmCipher, JsError> {
        if key.len() != KEY_SIZE {
            return Err(JsError::new(&format!(
                "Key must be {} bytes, got {}",
                KEY_SIZE,
                key.len()
            )));
        }
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| JsError::new(&format!("Failed to create cipher: {}", e)))?;
        Ok(Self { cipher })
    }

    /// 加密訊息
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<EncryptedMessage, JsError> {
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| JsError::new(&format!("Encryption failed: {}", e)))?;

        Ok(EncryptedMessage {
            ciphertext,
            nonce: nonce_bytes.to_vec(),
        })
    }

    /// 加密訊息 (附帶關聯資料)
    #[wasm_bindgen(js_name = encryptWithAad)]
    pub fn encrypt_with_aad(
        &self,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<EncryptedMessage, JsError> {
        use aes_gcm::aead::Payload;

        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let payload = Payload {
            msg: plaintext,
            aad,
        };

        let ciphertext = self
            .cipher
            .encrypt(nonce, payload)
            .map_err(|e| JsError::new(&format!("Encryption failed: {}", e)))?;

        Ok(EncryptedMessage {
            ciphertext,
            nonce: nonce_bytes.to_vec(),
        })
    }

    /// 解密訊息
    pub fn decrypt(&self, encrypted: &EncryptedMessage) -> Result<Vec<u8>, JsError> {
        if encrypted.nonce.len() != NONCE_SIZE {
            return Err(JsError::new("Invalid nonce size"));
        }

        let nonce = Nonce::from_slice(&encrypted.nonce);

        self.cipher
            .decrypt(nonce, encrypted.ciphertext.as_ref())
            .map_err(|e| JsError::new(&format!("Decryption failed: {}", e)))
    }

    /// 解密訊息 (附帶關聯資料)
    #[wasm_bindgen(js_name = decryptWithAad)]
    pub fn decrypt_with_aad(
        &self,
        encrypted: &EncryptedMessage,
        aad: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        use aes_gcm::aead::Payload;

        if encrypted.nonce.len() != NONCE_SIZE {
            return Err(JsError::new("Invalid nonce size"));
        }

        let nonce = Nonce::from_slice(&encrypted.nonce);

        let payload = Payload {
            msg: &encrypted.ciphertext,
            aad,
        };

        self.cipher
            .decrypt(nonce, payload)
            .map_err(|e| JsError::new(&format!("Decryption failed: {}", e)))
    }
}

/// 快速加密函式 (不需建立 Cipher 物件)
#[wasm_bindgen(js_name = aesEncrypt)]
pub fn aes_encrypt(key: &[u8], plaintext: &[u8]) -> Result<EncryptedMessage, JsError> {
    let cipher = AesGcmCipher::new(key)?;
    cipher.encrypt(plaintext)
}

/// 快速解密函式
#[wasm_bindgen(js_name = aesDecrypt)]
pub fn aes_decrypt(key: &[u8], encrypted: &EncryptedMessage) -> Result<Vec<u8>, JsError> {
    let cipher = AesGcmCipher::new(key)?;
    cipher.decrypt(encrypted)
}

/// 從位元組直接解密
#[wasm_bindgen(js_name = aesDecryptBytes)]
pub fn aes_decrypt_bytes(key: &[u8], encrypted_bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    let encrypted = EncryptedMessage::from_bytes(encrypted_bytes)?;
    aes_decrypt(key, &encrypted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aes_encrypt_decrypt() {
        let key = [0u8; 32];
        let plaintext = b"Hello, SafeTalk!";

        let cipher = AesGcmCipher::new(&key).unwrap();
        let encrypted = cipher.encrypt(plaintext).unwrap();
        let decrypted = cipher.decrypt(&encrypted).unwrap();

        assert_eq!(plaintext.to_vec(), decrypted);
    }

    #[test]
    fn test_aes_with_aad() {
        let key = [0u8; 32];
        let plaintext = b"Secret message";
        let aad = b"conversation_id_123";

        let cipher = AesGcmCipher::new(&key).unwrap();
        let encrypted = cipher.encrypt_with_aad(plaintext, aad).unwrap();
        let decrypted = cipher.decrypt_with_aad(&encrypted, aad).unwrap();

        assert_eq!(plaintext.to_vec(), decrypted);

        // 錯誤的 AAD 應該解密失敗
        let wrong_aad = b"wrong_id";
        assert!(cipher.decrypt_with_aad(&encrypted, wrong_aad).is_err());
    }

    #[test]
    fn test_encrypted_message_serialization() {
        let key = [0u8; 32];
        let plaintext = b"Test";

        let encrypted = aes_encrypt(&key, plaintext).unwrap();
        let bytes = encrypted.to_bytes();
        let restored = EncryptedMessage::from_bytes(&bytes).unwrap();

        let decrypted = aes_decrypt(&key, &restored).unwrap();
        assert_eq!(plaintext.to_vec(), decrypted);
    }
}
