//! X3DH (Extended Triple Diffie-Hellman) 金鑰交換協定
//!
//! 實作 Signal Protocol 的 X3DH 協定，用於建立初始共享密鑰

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519SecretKey};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use hkdf::Hkdf;
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use super::keys::X25519KeyPair;

const INFO: &[u8] = b"SafeTalk_X3DH";

/// X3DH 發起者輸出
#[wasm_bindgen]
#[derive(Serialize, Deserialize)]
pub struct X3DHSenderOutput {
    /// 共享密鑰 (32 bytes)
    shared_secret: Vec<u8>,
    /// 臨時公鑰 (發送給對方)
    ephemeral_public_key: Vec<u8>,
    /// 臨時私鑰 (用於 Double Ratchet 初始化)
    ephemeral_private_key: Vec<u8>,
    /// 使用的一次性預金鑰 ID (如有)
    used_one_time_prekey_id: Option<u32>,
}

#[wasm_bindgen]
impl X3DHSenderOutput {
    #[wasm_bindgen(getter, js_name = sharedSecret)]
    pub fn shared_secret(&self) -> Vec<u8> {
        self.shared_secret.clone()
    }

    #[wasm_bindgen(getter, js_name = ephemeralPublicKey)]
    pub fn ephemeral_public_key(&self) -> Vec<u8> {
        self.ephemeral_public_key.clone()
    }

    #[wasm_bindgen(getter, js_name = ephemeralPrivateKey)]
    pub fn ephemeral_private_key(&self) -> Vec<u8> {
        self.ephemeral_private_key.clone()
    }

    #[wasm_bindgen(getter, js_name = usedOneTimePrekeyId)]
    pub fn used_one_time_prekey_id(&self) -> Option<u32> {
        self.used_one_time_prekey_id
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self).map_err(|e| JsError::new(&e.to_string()))
    }
}

/// X3DH 初始訊息 (發送給接收者)
#[wasm_bindgen]
#[derive(Serialize, Deserialize, Clone)]
pub struct X3DHInitialMessage {
    /// 發送者身份公鑰
    sender_identity_key: Vec<u8>,
    /// 發送者臨時公鑰
    ephemeral_key: Vec<u8>,
    /// 使用的一次性預金鑰 ID (如有)
    one_time_prekey_id: Option<u32>,
}

#[wasm_bindgen]
impl X3DHInitialMessage {
    #[wasm_bindgen(getter, js_name = senderIdentityKey)]
    pub fn sender_identity_key(&self) -> Vec<u8> {
        self.sender_identity_key.clone()
    }

    #[wasm_bindgen(getter, js_name = ephemeralKey)]
    pub fn ephemeral_key(&self) -> Vec<u8> {
        self.ephemeral_key.clone()
    }

    #[wasm_bindgen(getter, js_name = oneTimePrekeyId)]
    pub fn one_time_prekey_id(&self) -> Option<u32> {
        self.one_time_prekey_id
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<X3DHInitialMessage, JsError> {
        serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(getter, js_name = senderIdentityKeyBase64)]
    pub fn sender_identity_key_base64(&self) -> String {
        BASE64.encode(&self.sender_identity_key)
    }
}

/// X3DH 協定實作
#[wasm_bindgen]
pub struct X3DH;

#[wasm_bindgen]
impl X3DH {
    /// 發起者：計算共享密鑰
    ///
    /// # 參數
    /// - `sender_identity`: 發送者的身份金鑰對
    /// - `recipient_bundle`: 接收者的 PreKeyBundle
    ///
    /// # 返回
    /// - X3DHSenderOutput 包含共享密鑰和臨時公鑰
    #[wasm_bindgen(js_name = initiatorCalculate)]
    pub fn initiator_calculate(
        sender_identity_private: &[u8],
        recipient_identity_public: &[u8],
        recipient_signed_prekey_public: &[u8],
        recipient_signed_prekey_signature: &[u8],
        recipient_one_time_prekey_public: Option<Vec<u8>>,
        recipient_one_time_prekey_id: Option<u32>,
    ) -> Result<X3DHSenderOutput, JsError> {

        // 驗證簽章
        if !Self::verify_signed_prekey(
            recipient_identity_public,
            recipient_signed_prekey_public,
            recipient_signed_prekey_signature,
        )? {
            return Err(JsError::new("Invalid signed prekey signature"));
        }

        // 生成臨時金鑰對
        let ephemeral = X25519KeyPair::new();

        // 從私鑰建立 X25519 金鑰 (身份金鑰轉換)
        let sender_x25519 = Self::ed25519_to_x25519_private(sender_identity_private)?;

        // 解析接收者公鑰
        let recipient_identity_x25519 = Self::ed25519_to_x25519_public(recipient_identity_public)?;
        let recipient_spk = Self::bytes_to_x25519_public(recipient_signed_prekey_public)?;

        // 計算 DH 值
        // DH1 = DH(IKa, SPKb)
        let dh1 = sender_x25519.diffie_hellman(&recipient_spk);

        // DH2 = DH(EKa, IKb)
        let ephemeral_secret = X25519SecretKey::from(Self::vec_to_32(&ephemeral.private_key_bytes())?);
        let dh2 = ephemeral_secret.diffie_hellman(&recipient_identity_x25519);

        // DH3 = DH(EKa, SPKb)
        let dh3 = ephemeral_secret.diffie_hellman(&recipient_spk);

        // 組合 DH 輸出
        let mut dh_concat = Vec::new();
        dh_concat.extend_from_slice(dh1.as_bytes());
        dh_concat.extend_from_slice(dh2.as_bytes());
        dh_concat.extend_from_slice(dh3.as_bytes());

        // DH4 = DH(EKa, OPKb) (如果有一次性預金鑰)
        let used_otpk_id = if let Some(otpk_public) = recipient_one_time_prekey_public {
            let recipient_otpk = Self::bytes_to_x25519_public(&otpk_public)?;
            let dh4 = ephemeral_secret.diffie_hellman(&recipient_otpk);
            dh_concat.extend_from_slice(dh4.as_bytes());
            recipient_one_time_prekey_id
        } else {
            None
        };

        // 使用 HKDF 導出最終密鑰
        let shared_secret = Self::kdf(&dh_concat)?;


        Ok(X3DHSenderOutput {
            shared_secret,
            ephemeral_public_key: ephemeral.public_key_bytes(),
            ephemeral_private_key: ephemeral.private_key_bytes(),
            used_one_time_prekey_id: used_otpk_id,
        })
    }

    /// 接收者：計算共享密鑰
    #[wasm_bindgen(js_name = responderCalculate)]
    pub fn responder_calculate(
        recipient_identity_private: &[u8],
        recipient_signed_prekey_private: &[u8],
        recipient_one_time_prekey_private: Option<Vec<u8>>,
        sender_identity_public: &[u8],
        sender_ephemeral_public: &[u8],
    ) -> Result<Vec<u8>, JsError> {

        // 轉換金鑰
        let recipient_x25519 = Self::ed25519_to_x25519_private(recipient_identity_private)?;
        let recipient_spk = X25519SecretKey::from(Self::vec_to_32(recipient_signed_prekey_private)?);

        let sender_identity_x25519 = Self::ed25519_to_x25519_public(sender_identity_public)?;
        let sender_ephemeral = Self::bytes_to_x25519_public(sender_ephemeral_public)?;

        // 計算 DH 值 (與發起者相反順序)
        // DH1 = DH(SPKb, IKa)
        let dh1 = recipient_spk.diffie_hellman(&sender_identity_x25519);

        // DH2 = DH(IKb, EKa)
        let dh2 = recipient_x25519.diffie_hellman(&sender_ephemeral);

        // DH3 = DH(SPKb, EKa)
        let dh3 = recipient_spk.diffie_hellman(&sender_ephemeral);

        // 組合 DH 輸出
        let mut dh_concat = Vec::new();
        dh_concat.extend_from_slice(dh1.as_bytes());
        dh_concat.extend_from_slice(dh2.as_bytes());
        dh_concat.extend_from_slice(dh3.as_bytes());

        // DH4 (如果有一次性預金鑰)
        if let Some(otpk_private) = recipient_one_time_prekey_private {
            let otpk = X25519SecretKey::from(Self::vec_to_32(&otpk_private)?);
            let dh4 = otpk.diffie_hellman(&sender_ephemeral);
            dh_concat.extend_from_slice(dh4.as_bytes());
        }

        // 使用 HKDF 導出最終密鑰
        let shared_secret = Self::kdf(&dh_concat)?;


        Ok(shared_secret)
    }

    /// 建立初始訊息
    #[wasm_bindgen(js_name = createInitialMessage)]
    pub fn create_initial_message(
        sender_identity_public: &[u8],
        ephemeral_public: &[u8],
        one_time_prekey_id: Option<u32>,
    ) -> X3DHInitialMessage {
        X3DHInitialMessage {
            sender_identity_key: sender_identity_public.to_vec(),
            ephemeral_key: ephemeral_public.to_vec(),
            one_time_prekey_id,
        }
    }

    /// 驗證簽署過的預金鑰
    fn verify_signed_prekey(
        identity_public: &[u8],
        prekey_public: &[u8],
        signature: &[u8],
    ) -> Result<bool, JsError> {
        if identity_public.len() != 32 || signature.len() != 64 {
            return Err(JsError::new("Invalid key or signature length"));
        }

        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(identity_public);

        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(signature);

        let verifying_key = VerifyingKey::from_bytes(&pk_bytes)
            .map_err(|e| JsError::new(&format!("Invalid identity key: {}", e)))?;

        let signature = Signature::from_bytes(&sig_bytes);

        Ok(verifying_key.verify(prekey_public, &signature).is_ok())
    }

    /// KDF 函式
    fn kdf(input: &[u8]) -> Result<Vec<u8>, JsError> {
        let hkdf = Hkdf::<Sha256>::new(None, input);
        let mut output = [0u8; 32];
        hkdf.expand(INFO, &mut output)
            .map_err(|e| JsError::new(&format!("HKDF failed: {}", e)))?;
        Ok(output.to_vec())
    }

    /// Ed25519 私鑰轉 X25519 私鑰
    fn ed25519_to_x25519_private(ed_private: &[u8]) -> Result<X25519SecretKey, JsError> {
        use sha2::{Sha512, Digest};

        if ed_private.len() != 32 {
            return Err(JsError::new("Invalid Ed25519 private key length"));
        }

        // 根據 RFC 8032，Ed25519 私鑰經過 SHA-512 雜湊後的前 32 位元組可用於 X25519
        let mut hasher = Sha512::new();
        hasher.update(ed_private);
        let hash = hasher.finalize();

        let mut x25519_bytes = [0u8; 32];
        x25519_bytes.copy_from_slice(&hash[..32]);

        // 清除位元 (根據 Curve25519 要求)
        x25519_bytes[0] &= 248;
        x25519_bytes[31] &= 127;
        x25519_bytes[31] |= 64;

        Ok(X25519SecretKey::from(x25519_bytes))
    }

    /// Ed25519 公鑰轉 X25519 公鑰
    fn ed25519_to_x25519_public(ed_public: &[u8]) -> Result<X25519PublicKey, JsError> {
        use curve25519_dalek::edwards::CompressedEdwardsY;

        if ed_public.len() != 32 {
            return Err(JsError::new("Invalid Ed25519 public key length"));
        }

        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(ed_public);

        let compressed = CompressedEdwardsY(pk_bytes);
        let edwards_point = compressed
            .decompress()
            .ok_or_else(|| JsError::new("Invalid Ed25519 public key"))?;

        let montgomery_point = edwards_point.to_montgomery();
        Ok(X25519PublicKey::from(montgomery_point.to_bytes()))
    }

    fn bytes_to_x25519_public(bytes: &[u8]) -> Result<X25519PublicKey, JsError> {
        if bytes.len() != 32 {
            return Err(JsError::new("Public key must be 32 bytes"));
        }
        let mut pk_bytes = [0u8; 32];
        pk_bytes.copy_from_slice(bytes);
        Ok(X25519PublicKey::from(pk_bytes))
    }

    fn vec_to_32(v: &[u8]) -> Result<[u8; 32], JsError> {
        if v.len() != 32 {
            return Err(JsError::new("Expected 32 bytes"));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(v);
        Ok(arr)
    }
}

/// 簽署預金鑰
#[wasm_bindgen(js_name = signPreKey)]
pub fn sign_pre_key(identity_private: &[u8], prekey_public: &[u8]) -> Result<Vec<u8>, JsError> {
    if identity_private.len() != 32 {
        return Err(JsError::new("Invalid identity private key length"));
    }

    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(identity_private);

    let signing_key = SigningKey::from_bytes(&key_bytes);
    let signature = signing_key.sign(prekey_public);

    Ok(signature.to_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::keys::IdentityKeyPair;

    #[test]
    fn test_x3dh_key_exchange() {
        // Alice (發起者)
        let alice_identity = IdentityKeyPair::new();

        // Bob (接收者)
        let bob_identity = IdentityKeyPair::new();
        let bob_signed_prekey = X25519KeyPair::new();
        let bob_one_time_prekey = X25519KeyPair::new();

        // Bob 簽署預金鑰
        let bob_spk_signature = sign_pre_key(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
        ).unwrap();

        // Alice 計算共享密鑰
        let alice_output = X3DH::initiator_calculate(
            &alice_identity.private_key_bytes(),
            &bob_identity.public_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
            &bob_spk_signature,
            Some(bob_one_time_prekey.public_key_bytes()),
            Some(1),
        ).unwrap();

        // Bob 計算共享密鑰
        let bob_shared = X3DH::responder_calculate(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.private_key_bytes(),
            Some(bob_one_time_prekey.private_key_bytes()),
            &alice_identity.public_key_bytes(),
            &alice_output.ephemeral_public_key,
        ).unwrap();

        // 驗證雙方得到相同的共享密鑰
        assert_eq!(alice_output.shared_secret, bob_shared);
    }

    #[test]
    fn test_x3dh_without_otp() {
        // 測試沒有 OneTimePreKey 的情況（真實 App 流程）
        let alice_identity = IdentityKeyPair::new();
        let bob_identity = IdentityKeyPair::new();
        let bob_signed_prekey = X25519KeyPair::new();

        // Bob 簽署預金鑰
        let bob_spk_signature = sign_pre_key(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
        ).unwrap();

        // Alice 計算（沒有 OTP）
        let alice_output = X3DH::initiator_calculate(
            &alice_identity.private_key_bytes(),
            &bob_identity.public_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
            &bob_spk_signature,
            None,  // 沒有 OTP
            None,
        ).unwrap();

        // Bob 計算（沒有 OTP）
        let bob_shared = X3DH::responder_calculate(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.private_key_bytes(),
            None,  // 沒有 OTP
            &alice_identity.public_key_bytes(),
            &alice_output.ephemeral_public_key,
        ).unwrap();

        // 驗證共享密鑰相同
        assert_eq!(alice_output.shared_secret, bob_shared);
        println!("X3DH without OTP: shared secrets match!");
    }

    #[test]
    fn test_ed25519_to_x25519_conversion_consistency() {
        // 驗證 Ed25519 私鑰轉 X25519 後，計算出的公鑰與直接轉換 Ed25519 公鑰相同
        use x25519_dalek::PublicKey as X25519PublicKey;

        let identity = IdentityKeyPair::new();

        // 方法 1: Ed25519 私鑰 -> X25519 私鑰 -> X25519 公鑰
        let x25519_private = X3DH::ed25519_to_x25519_private(&identity.private_key_bytes()).unwrap();
        let x25519_public_from_private = X25519PublicKey::from(&x25519_private);

        // 方法 2: Ed25519 公鑰 -> X25519 公鑰
        let x25519_public_from_ed_public = X3DH::ed25519_to_x25519_public(&identity.public_key_bytes()).unwrap();

        // 這兩個應該相同

        assert_eq!(
            x25519_public_from_private.as_bytes(),
            x25519_public_from_ed_public.as_bytes(),
            "Ed25519 to X25519 conversion inconsistency!"
        );
    }

    #[test]
    fn test_full_encryption_flow() {
        use super::super::ratchet::RatchetSession;

        // 模擬完整的加密流程
        let alice_identity = IdentityKeyPair::new();
        let bob_identity = IdentityKeyPair::new();
        let bob_signed_prekey = X25519KeyPair::new();

        let bob_spk_signature = sign_pre_key(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
        ).unwrap();

        // X3DH
        let alice_x3dh = X3DH::initiator_calculate(
            &alice_identity.private_key_bytes(),
            &bob_identity.public_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
            &bob_spk_signature,
            None,
            None,
        ).unwrap();

        let bob_shared = X3DH::responder_calculate(
            &bob_identity.private_key_bytes(),
            &bob_signed_prekey.private_key_bytes(),
            None,
            &alice_identity.public_key_bytes(),
            &alice_x3dh.ephemeral_public_key,
        ).unwrap();

        assert_eq!(alice_x3dh.shared_secret, bob_shared, "X3DH shared secrets don't match!");

        // Double Ratchet
        let mut alice_session = RatchetSession::init_as_alice(
            &alice_x3dh.shared_secret,
            &bob_signed_prekey.public_key_bytes(),
            &alice_x3dh.ephemeral_private_key,
            &alice_x3dh.ephemeral_public_key,
        ).unwrap();

        let mut bob_session = RatchetSession::init_as_bob(
            &bob_shared,
            &bob_signed_prekey.private_key_bytes(),
            &bob_signed_prekey.public_key_bytes(),
            &alice_x3dh.ephemeral_public_key,
        ).unwrap();

        // Alice 發送給 Bob
        let msg = alice_session.encrypt(b"Hello from Alice!").unwrap();
        let decrypted = bob_session.decrypt(&msg).unwrap();
        assert_eq!(decrypted, b"Hello from Alice!");
        println!("Full flow test passed!");
    }
}
