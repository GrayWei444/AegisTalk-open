//! Double Ratchet 協定實作
//!
//! 提供前向安全性 (Forward Secrecy) 和後向安全性 (Break-in Recovery)

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519SecretKey};
use hkdf::Hkdf;
use sha2::Sha256;
use hmac::{Hmac, Mac};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use super::aes::{AesGcmCipher, EncryptedMessage};
use super::keys::X25519KeyPair;

const MAX_SKIP: u32 = 1000;
const INFO_RATCHET: &[u8] = b"SafeTalk_Ratchet";
const INFO_MESSAGE_KEYS: &[u8] = b"SafeTalk_MessageKeys";

/// 訊息金鑰
#[derive(Clone, Serialize, Deserialize)]
struct MessageKeys {
    cipher_key: [u8; 32],
    mac_key: [u8; 32],
    iv: [u8; 16],
}

/// 跳過的訊息金鑰 (用於處理亂序訊息)
#[derive(Clone, Serialize, Deserialize, Default)]
struct SkippedKeys {
    /// Key: (ratchet_public_key_base64, message_number)
    keys: std::collections::HashMap<(String, u32), MessageKeys>,
}

/// Double Ratchet 會話狀態
#[wasm_bindgen]
#[derive(Clone, Serialize, Deserialize)]
pub struct RatchetSession {
    /// 我方的 DH 金鑰對
    dh_self: DhKeyPair,
    /// 對方的 DH 公鑰
    dh_remote: Option<Vec<u8>>,
    /// 根金鑰
    root_key: [u8; 32],
    /// 發送鏈金鑰
    chain_key_send: Option<[u8; 32]>,
    /// 接收鏈金鑰
    chain_key_recv: Option<[u8; 32]>,
    /// 發送訊息計數
    send_count: u32,
    /// 接收訊息計數
    recv_count: u32,
    /// 前一個發送鏈的訊息數量
    prev_send_count: u32,
    /// 跳過的訊息金鑰
    skipped_keys: SkippedKeys,
}

#[derive(Clone, Serialize, Deserialize)]
struct DhKeyPair {
    public: Vec<u8>,
    private: Vec<u8>,
}

impl DhKeyPair {
    fn new() -> Self {
        let keypair = X25519KeyPair::new();
        Self {
            public: keypair.public_key_bytes(),
            private: keypair.private_key_bytes(),
        }
    }

    fn diffie_hellman(&self, their_public: &[u8]) -> Result<[u8; 32], JsError> {
        let mut private_bytes = [0u8; 32];
        private_bytes.copy_from_slice(&self.private);
        let secret = X25519SecretKey::from(private_bytes);

        let mut public_bytes = [0u8; 32];
        public_bytes.copy_from_slice(their_public);
        let their_public = X25519PublicKey::from(public_bytes);

        let shared = secret.diffie_hellman(&their_public);
        Ok(*shared.as_bytes())
    }
}

/// 加密後的 Ratchet 訊息
#[wasm_bindgen]
#[derive(Clone, Serialize, Deserialize)]
pub struct RatchetMessage {
    /// 發送者的 DH 公鑰
    dh_public: Vec<u8>,
    /// 前一個鏈的訊息數量
    prev_chain_count: u32,
    /// 訊息編號
    message_number: u32,
    /// 加密的訊息內容
    ciphertext: Vec<u8>,
    /// Nonce
    nonce: Vec<u8>,
}

#[wasm_bindgen]
impl RatchetMessage {
    #[wasm_bindgen(getter, js_name = dhPublic)]
    pub fn dh_public(&self) -> Vec<u8> {
        self.dh_public.clone()
    }

    #[wasm_bindgen(getter, js_name = prevChainCount)]
    pub fn prev_chain_count(&self) -> u32 {
        self.prev_chain_count
    }

    #[wasm_bindgen(getter, js_name = messageNumber)]
    pub fn message_number(&self) -> u32 {
        self.message_number
    }

    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<RatchetMessage, JsError> {
        serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsError> {
        bincode::serialize(self).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<RatchetMessage, JsError> {
        bincode::deserialize(bytes).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(getter, js_name = dhPublicBase64)]
    pub fn dh_public_base64(&self) -> String {
        BASE64.encode(&self.dh_public)
    }
}

#[wasm_bindgen]
impl RatchetSession {
    /// 發起者建立會話 (Alice)
    ///
    /// # 參數
    /// - `shared_secret`: X3DH 產生的共享密鑰
    /// - `remote_public_key`: 接收者的 Signed PreKey 公鑰
    /// - `ephemeral_private_key`: Alice 的 X3DH 臨時私鑰
    /// - `ephemeral_public_key`: Alice 的 X3DH 臨時公鑰
    #[wasm_bindgen(js_name = initAsAlice)]
    pub fn init_as_alice(
        shared_secret: &[u8],
        remote_public_key: &[u8],
        ephemeral_private_key: &[u8],
        ephemeral_public_key: &[u8],
    ) -> Result<RatchetSession, JsError> {
        if shared_secret.len() != 32 {
            return Err(JsError::new("Shared secret must be 32 bytes"));
        }
        if ephemeral_private_key.len() != 32 || ephemeral_public_key.len() != 32 {
            return Err(JsError::new("Ephemeral keys must be 32 bytes"));
        }


        // 使用 X3DH 的臨時金鑰對，而不是生成新的
        let dh_self = DhKeyPair {
            public: ephemeral_public_key.to_vec(),
            private: ephemeral_private_key.to_vec(),
        };

        // DH 輸出
        let dh_output = dh_self.diffie_hellman(remote_public_key)?;


        // KDF 產生根金鑰和發送鏈金鑰
        let (root_key, chain_key) = Self::kdf_rk(shared_secret, &dh_output)?;


        Ok(RatchetSession {
            dh_self,
            dh_remote: Some(remote_public_key.to_vec()),
            root_key,
            chain_key_send: Some(chain_key),
            chain_key_recv: None,
            send_count: 0,
            recv_count: 0,
            prev_send_count: 0,
            skipped_keys: SkippedKeys::default(),
        })
    }

    /// 接收者建立會話 (Bob)
    ///
    /// # 參數
    /// - `shared_secret`: X3DH 產生的共享密鑰
    /// - `signed_prekey_private`: Bob 的 Signed PreKey 私鑰
    /// - `signed_prekey_public`: Bob 的 Signed PreKey 公鑰
    /// - `remote_ephemeral_public`: Alice 的臨時公鑰 (用於雙向通訊)
    #[wasm_bindgen(js_name = initAsBob)]
    pub fn init_as_bob(
        shared_secret: &[u8],
        signed_prekey_private: &[u8],
        signed_prekey_public: &[u8],
        remote_ephemeral_public: &[u8],
    ) -> Result<RatchetSession, JsError> {
        if shared_secret.len() != 32 {
            return Err(JsError::new("Shared secret must be 32 bytes"));
        }


        let dh_self = DhKeyPair {
            public: signed_prekey_public.to_vec(),
            private: signed_prekey_private.to_vec(),
        };

        // 使用 Alice 的臨時公鑰進行 DH 運算，衍生接收鏈金鑰
        // 注意：Bob 是接收者，需要 chain_key_recv 來解密 Alice 的訊息
        // Bob 的 chain_key_send 會在他發送第一條訊息時透過 DH ratchet 衍生
        let dh_output = dh_self.diffie_hellman(remote_ephemeral_public)?;


        let (root_key, chain_key_recv) = Self::kdf_rk(shared_secret, &dh_output)?;


        Ok(RatchetSession {
            dh_self,
            dh_remote: Some(remote_ephemeral_public.to_vec()),
            root_key,
            chain_key_send: None,  // Bob 尚未發送，會在第一次發送時透過 DH ratchet 衍生
            chain_key_recv: Some(chain_key_recv),  // Bob 需要這個來接收 Alice 的訊息
            send_count: 0,
            recv_count: 0,
            prev_send_count: 0,
            skipped_keys: SkippedKeys::default(),
        })
    }

    /// 加密訊息
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<RatchetMessage, JsError> {
        // 如果沒有發送鏈金鑰（例如 Bob 第一次發送），需要先進行 DH ratchet
        if self.chain_key_send.is_none() {
            let dh_remote = self.dh_remote.as_ref()
                .ok_or_else(|| JsError::new("No remote public key for sending ratchet"))?;

            // 生成新的 DH 金鑰對
            let new_dh = DhKeyPair::new();

            // 計算 DH 輸出並衍生發送鏈金鑰
            let dh_output = new_dh.diffie_hellman(dh_remote)?;
            let (root_key, chain_key_send) = Self::kdf_rk(&self.root_key, &dh_output)?;

            // 更新狀態
            self.root_key = root_key;
            self.chain_key_send = Some(chain_key_send);
            self.dh_self = new_dh;
            self.prev_send_count = self.send_count;
            self.send_count = 0;
        }

        let chain_key = self.chain_key_send
            .ok_or_else(|| JsError::new("No sending chain key"))?;

        // 產生訊息金鑰
        let message_keys = Self::kdf_ck(&chain_key)?;

        // 更新鏈金鑰
        self.chain_key_send = Some(Self::chain_key_step(&chain_key)?);

        // 加密
        let cipher = AesGcmCipher::new(&message_keys.cipher_key)?;
        let encrypted = cipher.encrypt(plaintext)?;

        let message = RatchetMessage {
            dh_public: self.dh_self.public.clone(),
            prev_chain_count: self.prev_send_count,
            message_number: self.send_count,
            ciphertext: encrypted.ciphertext(),
            nonce: encrypted.nonce(),
        };

        self.send_count += 1;

        Ok(message)
    }

    /// 解密訊息
    pub fn decrypt(&mut self, message: &RatchetMessage) -> Result<Vec<u8>, JsError> {
        // 嘗試使用跳過的金鑰
        let pk_base64 = BASE64.encode(&message.dh_public);
        if let Some(mk) = self.skipped_keys.keys.remove(&(pk_base64.clone(), message.message_number)) {
            return Self::decrypt_with_keys(&mk, message);
        }

        // 檢查是否需要 DH ratchet
        let need_ratchet = match &self.dh_remote {
            None => true,
            Some(remote) => remote != &message.dh_public,
        };

        if need_ratchet {
            // 儲存跳過的訊息金鑰
            self.skip_message_keys(message.prev_chain_count)?;

            // 執行 DH ratchet
            self.dh_ratchet(&message.dh_public)?;
        }

        // 跳過到目標訊息
        self.skip_message_keys(message.message_number)?;

        // 產生訊息金鑰
        let chain_key = self.chain_key_recv
            .ok_or_else(|| JsError::new("No receiving chain key"))?;

        let message_keys = Self::kdf_ck(&chain_key)?;

        // 更新鏈金鑰和計數
        self.chain_key_recv = Some(Self::chain_key_step(&chain_key)?);
        self.recv_count += 1;

        // 解密
        Self::decrypt_with_keys(&message_keys, message)
    }

    /// DH Ratchet 步驟
    fn dh_ratchet(&mut self, their_public: &[u8]) -> Result<(), JsError> {
        // 儲存前一個發送鏈的計數
        self.prev_send_count = self.send_count;
        self.send_count = 0;
        self.recv_count = 0;

        // 更新對方公鑰
        self.dh_remote = Some(their_public.to_vec());

        // 計算新的接收鏈金鑰
        let dh_output = self.dh_self.diffie_hellman(their_public)?;
        let (root_key, chain_key_recv) = Self::kdf_rk(&self.root_key, &dh_output)?;
        self.root_key = root_key;
        self.chain_key_recv = Some(chain_key_recv);

        // 生成新的 DH 金鑰對
        self.dh_self = DhKeyPair::new();

        // 計算新的發送鏈金鑰
        let dh_output = self.dh_self.diffie_hellman(their_public)?;
        let (root_key, chain_key_send) = Self::kdf_rk(&self.root_key, &dh_output)?;
        self.root_key = root_key;
        self.chain_key_send = Some(chain_key_send);

        Ok(())
    }

    /// 跳過訊息金鑰
    fn skip_message_keys(&mut self, until: u32) -> Result<(), JsError> {
        if let Some(chain_key) = &self.chain_key_recv {
            if self.recv_count + MAX_SKIP < until {
                return Err(JsError::new("Too many skipped messages"));
            }

            let pk_base64 = self.dh_remote
                .as_ref()
                .map(|pk| BASE64.encode(pk))
                .unwrap_or_default();

            let mut current_chain_key = *chain_key;

            while self.recv_count < until {
                let mk = Self::kdf_ck(&current_chain_key)?;
                self.skipped_keys.keys.insert((pk_base64.clone(), self.recv_count), mk);
                current_chain_key = Self::chain_key_step(&current_chain_key)?;
                self.recv_count += 1;
            }

            self.chain_key_recv = Some(current_chain_key);
        }
        Ok(())
    }

    /// 使用訊息金鑰解密
    fn decrypt_with_keys(keys: &MessageKeys, message: &RatchetMessage) -> Result<Vec<u8>, JsError> {
        let cipher = AesGcmCipher::new(&keys.cipher_key)?;
        let encrypted = EncryptedMessage::from_bytes(
            &[message.nonce.clone(), message.ciphertext.clone()].concat()
        )?;
        cipher.decrypt(&encrypted)
    }

    /// KDF for root key (HKDF)
    fn kdf_rk(root_key: &[u8], dh_output: &[u8]) -> Result<([u8; 32], [u8; 32]), JsError> {
        let hkdf = Hkdf::<Sha256>::new(Some(root_key), dh_output);
        let mut output = [0u8; 64];
        hkdf.expand(INFO_RATCHET, &mut output)
            .map_err(|e| JsError::new(&format!("HKDF failed: {}", e)))?;

        let mut new_root = [0u8; 32];
        let mut chain_key = [0u8; 32];
        new_root.copy_from_slice(&output[..32]);
        chain_key.copy_from_slice(&output[32..]);

        Ok((new_root, chain_key))
    }

    /// KDF for chain key (HMAC)
    fn kdf_ck(chain_key: &[u8; 32]) -> Result<MessageKeys, JsError> {
        type HmacSha256 = Hmac<Sha256>;

        let mut mac = HmacSha256::new_from_slice(chain_key)
            .map_err(|e| JsError::new(&format!("HMAC failed: {}", e)))?;
        mac.update(&[0x01]);
        let message_key = mac.finalize().into_bytes();

        let mut mac = HmacSha256::new_from_slice(chain_key)
            .map_err(|e| JsError::new(&format!("HMAC failed: {}", e)))?;
        mac.update(&[0x02]);
        let mac_key = mac.finalize().into_bytes();

        let mut cipher_key = [0u8; 32];
        let mut mac_key_arr = [0u8; 32];
        cipher_key.copy_from_slice(&message_key);
        mac_key_arr.copy_from_slice(&mac_key);

        // 使用 cipher_key 的一部分作為 IV
        let mut iv = [0u8; 16];
        let hkdf = Hkdf::<Sha256>::new(None, &cipher_key);
        hkdf.expand(INFO_MESSAGE_KEYS, &mut iv)
            .map_err(|e| JsError::new(&format!("HKDF failed: {}", e)))?;

        Ok(MessageKeys {
            cipher_key,
            mac_key: mac_key_arr,
            iv,
        })
    }

    /// 鏈金鑰步進
    fn chain_key_step(chain_key: &[u8; 32]) -> Result<[u8; 32], JsError> {
        type HmacSha256 = Hmac<Sha256>;

        let mut mac = HmacSha256::new_from_slice(chain_key)
            .map_err(|e| JsError::new(&format!("HMAC failed: {}", e)))?;
        mac.update(&[0x03]);
        let result = mac.finalize().into_bytes();

        let mut new_chain_key = [0u8; 32];
        new_chain_key.copy_from_slice(&result);
        Ok(new_chain_key)
    }

    /// 序列化會話狀態
    #[wasm_bindgen(js_name = serialize)]
    pub fn serialize(&self) -> Result<Vec<u8>, JsError> {
        bincode::serialize(self).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 還原會話狀態
    #[wasm_bindgen(js_name = deserialize)]
    pub fn deserialize(bytes: &[u8]) -> Result<RatchetSession, JsError> {
        bincode::deserialize(bytes).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 取得我方當前 DH 公鑰
    #[wasm_bindgen(getter, js_name = myPublicKey)]
    pub fn my_public_key(&self) -> Vec<u8> {
        self.dh_self.public.clone()
    }

    /// 取得我方當前 DH 公鑰 (Base64)
    #[wasm_bindgen(getter, js_name = myPublicKeyBase64)]
    pub fn my_public_key_base64(&self) -> String {
        BASE64.encode(&self.dh_self.public)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_double_ratchet() {
        let shared_secret = [0u8; 32];
        let bob_spk = X25519KeyPair::new();
        let alice_ephemeral = X25519KeyPair::new();

        // Alice 初始化（使用她的臨時金鑰對）
        let mut alice = RatchetSession::init_as_alice(
            &shared_secret,
            &bob_spk.public_key_bytes(),
            &alice_ephemeral.private_key_bytes(),
            &alice_ephemeral.public_key_bytes(),
        ).unwrap();

        // Bob 初始化（需要 Alice 的臨時公鑰）
        let mut bob = RatchetSession::init_as_bob(
            &shared_secret,
            &bob_spk.private_key_bytes(),
            &bob_spk.public_key_bytes(),
            &alice_ephemeral.public_key_bytes(),
        ).unwrap();

        // Alice 發送訊息給 Bob
        let msg1 = alice.encrypt(b"Hello Bob!").unwrap();
        let decrypted1 = bob.decrypt(&msg1).unwrap();
        assert_eq!(decrypted1, b"Hello Bob!");

        // Bob 回覆 Alice
        let msg2 = bob.encrypt(b"Hi Alice!").unwrap();
        let decrypted2 = alice.decrypt(&msg2).unwrap();
        assert_eq!(decrypted2, b"Hi Alice!");

        // 多輪通訊
        let msg3 = alice.encrypt(b"Message 3").unwrap();
        let msg4 = alice.encrypt(b"Message 4").unwrap();

        // Bob 可以按順序解密
        let d3 = bob.decrypt(&msg3).unwrap();
        let d4 = bob.decrypt(&msg4).unwrap();
        assert_eq!(d3, b"Message 3");
        assert_eq!(d4, b"Message 4");
    }
}
