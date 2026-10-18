//! Hashes and the symmetric ciphers source scripts use through Hutool-style
//! calls: AES, DES, and DESede with ECB or CBC and PKCS5, zero, or no padding.

use base64::Engine as _;
use cipher::block_padding::{NoPadding, Pkcs7, ZeroPadding};
use cipher::{BlockDecryptMut, BlockEncryptMut, KeyInit, KeyIvInit};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};

pub fn md5_hex(data: &[u8]) -> String {
    hex::encode(Md5::digest(data))
}

pub fn digest(data: &[u8], algorithm: &str) -> Result<Vec<u8>, String> {
    let normalized = algorithm.to_ascii_uppercase().replace('-', "");
    Ok(match normalized.as_str() {
        "MD5" => Md5::digest(data).to_vec(),
        "SHA1" | "SHA" => sha1::Sha1::digest(data).to_vec(),
        "SHA224" => sha2::Sha224::digest(data).to_vec(),
        "SHA256" => sha2::Sha256::digest(data).to_vec(),
        "SHA384" => sha2::Sha384::digest(data).to_vec(),
        "SHA512" => sha2::Sha512::digest(data).to_vec(),
        _ => return Err(format!("不支持的摘要算法：{algorithm}")),
    })
}

pub fn hmac(data: &[u8], algorithm: &str, key: &[u8]) -> Result<Vec<u8>, String> {
    let normalized = algorithm
        .to_ascii_uppercase()
        .replace('-', "")
        .trim_start_matches("HMAC")
        .to_string();
    macro_rules! run {
        ($digest:ty) => {{
            let mut mac = <Hmac<$digest> as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
            mac.update(data);
            mac.finalize().into_bytes().to_vec()
        }};
    }
    Ok(match normalized.as_str() {
        "MD5" => run!(Md5),
        "SHA1" => run!(sha1::Sha1),
        "SHA224" => run!(sha2::Sha224),
        "SHA256" => run!(sha2::Sha256),
        "SHA384" => run!(sha2::Sha384),
        "SHA512" => run!(sha2::Sha512),
        _ => return Err(format!("不支持的 HMAC 算法：{algorithm}")),
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Algorithm {
    Aes,
    Des,
    TripleDes,
    /// A stream cipher: no mode, padding, or IV.
    Rc4,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum BlockMode {
    Ecb,
    Cbc,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Padding {
    Pkcs,
    Zero,
    None,
}

/// A cipher described by a Java transformation such as `AES/CBC/PKCS5Padding`.
#[derive(Debug, Clone)]
pub struct SymmetricCrypto {
    algorithm: Algorithm,
    mode: BlockMode,
    padding: Padding,
    key: Vec<u8>,
    iv: Vec<u8>,
}

impl SymmetricCrypto {
    pub fn new(transformation: &str, key: &[u8], iv: Option<&[u8]>) -> Result<Self, String> {
        let parts: Vec<String> = transformation
            .split('/')
            .map(|part| part.trim().to_ascii_uppercase())
            .collect();
        let algorithm = match parts[0].as_str() {
            "AES" => Algorithm::Aes,
            "DES" => Algorithm::Des,
            "DESEDE" | "3DES" | "TRIPLEDES" => Algorithm::TripleDes,
            "RC4" | "ARCFOUR" => {
                if key.is_empty() || key.len() > 256 {
                    return Err(format!("RC4 密钥长度 {} 字节无效", key.len()));
                }
                return Ok(Self {
                    algorithm: Algorithm::Rc4,
                    mode: BlockMode::Ecb,
                    padding: Padding::None,
                    key: key.to_vec(),
                    iv: Vec::new(),
                });
            }
            other => return Err(format!("不支持的加密算法：{other}")),
        };
        let mode = match parts.get(1).map(String::as_str) {
            None | Some("ECB") => BlockMode::Ecb,
            Some("CBC") => BlockMode::Cbc,
            Some(other) => return Err(format!("不支持的加密模式：{other}")),
        };
        let padding = match parts.get(2).map(String::as_str) {
            None | Some("PKCS5PADDING") | Some("PKCS7PADDING") => Padding::Pkcs,
            Some("ZEROPADDING") => Padding::Zero,
            Some("NOPADDING") => Padding::None,
            Some(other) => return Err(format!("不支持的填充方式：{other}")),
        };
        let block = if algorithm == Algorithm::Aes { 16 } else { 8 };
        let iv = match (mode, iv) {
            (BlockMode::Cbc, Some(iv)) => iv.to_vec(),
            (BlockMode::Cbc, None) => vec![0; block],
            (BlockMode::Ecb, _) => Vec::new(),
        };
        if mode == BlockMode::Cbc && iv.len() != block {
            return Err(format!("IV 长度应为 {block} 字节，实际为 {}", iv.len()));
        }
        let key = match algorithm {
            Algorithm::TripleDes if key.len() == 16 => [key, &key[..8]].concat(),
            _ => key.to_vec(),
        };
        Ok(Self {
            algorithm,
            mode,
            padding,
            key,
            iv,
        })
    }

    pub fn encrypt(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        if self.algorithm == Algorithm::Rc4 {
            return Ok(rc4(&self.key, data));
        }
        macro_rules! run {
            ($cipher:ty) => {{
                match (self.mode, self.padding) {
                    (BlockMode::Ecb, Padding::Pkcs) => {
                        ecb::Encryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<Pkcs7>(data)
                    }
                    (BlockMode::Ecb, Padding::Zero) => {
                        ecb::Encryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<ZeroPadding>(data)
                    }
                    (BlockMode::Ecb, Padding::None) => {
                        ecb::Encryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<NoPadding>(data)
                    }
                    (BlockMode::Cbc, Padding::Pkcs) => {
                        cbc::Encryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<Pkcs7>(data)
                    }
                    (BlockMode::Cbc, Padding::Zero) => {
                        cbc::Encryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<ZeroPadding>(data)
                    }
                    (BlockMode::Cbc, Padding::None) => {
                        cbc::Encryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .encrypt_padded_vec_mut::<NoPadding>(data)
                    }
                }
            }};
        }
        Ok(match (self.algorithm, self.key.len()) {
            (Algorithm::Aes, 16) => run!(aes::Aes128),
            (Algorithm::Aes, 24) => run!(aes::Aes192),
            (Algorithm::Aes, 32) => run!(aes::Aes256),
            (Algorithm::Des, 8) => run!(des::Des),
            (Algorithm::TripleDes, 24) => run!(des::TdesEde3),
            (_, length) => return Err(format!("密钥长度 {length} 字节不适用于该算法")),
        })
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        if data.is_empty() {
            return Err("密文为空".to_string());
        }
        if self.algorithm == Algorithm::Rc4 {
            return Ok(rc4(&self.key, data));
        }
        macro_rules! run {
            ($cipher:ty) => {{
                let failed = |e: cipher::block_padding::UnpadError| format!("解密失败：{e}");
                match (self.mode, self.padding) {
                    (BlockMode::Ecb, Padding::Pkcs) => {
                        ecb::Decryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<Pkcs7>(data)
                            .map_err(failed)?
                    }
                    (BlockMode::Ecb, Padding::Zero) => {
                        ecb::Decryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<ZeroPadding>(data)
                            .map_err(failed)?
                    }
                    (BlockMode::Ecb, Padding::None) => {
                        ecb::Decryptor::<$cipher>::new_from_slice(&self.key)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<NoPadding>(data)
                            .map_err(failed)?
                    }
                    (BlockMode::Cbc, Padding::Pkcs) => {
                        cbc::Decryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<Pkcs7>(data)
                            .map_err(failed)?
                    }
                    (BlockMode::Cbc, Padding::Zero) => {
                        cbc::Decryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<ZeroPadding>(data)
                            .map_err(failed)?
                    }
                    (BlockMode::Cbc, Padding::None) => {
                        cbc::Decryptor::<$cipher>::new_from_slices(&self.key, &self.iv)
                            .map_err(|e| e.to_string())?
                            .decrypt_padded_vec_mut::<NoPadding>(data)
                            .map_err(failed)?
                    }
                }
            }};
        }
        Ok(match (self.algorithm, self.key.len()) {
            (Algorithm::Aes, 16) => run!(aes::Aes128),
            (Algorithm::Aes, 24) => run!(aes::Aes192),
            (Algorithm::Aes, 32) => run!(aes::Aes256),
            (Algorithm::Des, 8) => run!(des::Des),
            (Algorithm::TripleDes, 24) => run!(des::TdesEde3),
            (_, length) => return Err(format!("密钥长度 {length} 字节不适用于该算法")),
        })
    }
}

/// RC4, which encrypts and decrypts alike; `key` is 1 to 256 bytes.
fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut state: Vec<u8> = (0..=255).collect();
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(state[i]).wrapping_add(key[i % key.len()]);
        state.swap(i, j as usize);
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|byte| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(state[i as usize]);
            state.swap(i as usize, j as usize);
            let k = state[state[i as usize].wrapping_add(state[j as usize]) as usize];
            byte ^ k
        })
        .collect()
}

/// Hutool's `SecureUtil.decode`: hex when the text is hex, else Base64.
pub fn decode_cipher_text(text: &str) -> Result<Vec<u8>, String> {
    let trimmed = text.trim();
    if !trimmed.is_empty()
        && trimmed.len().is_multiple_of(2)
        && trimmed.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return hex::decode(trimmed).map_err(|e| e.to_string());
    }
    base64_decode(trimmed, 0)
}

/// Android `Base64` flags: 1 no padding, 2 no wrap, 8 URL-safe.
pub fn base64_encode(data: &[u8], flags: i64) -> String {
    let url_safe = flags & 8 != 0;
    let no_padding = flags & 1 != 0;
    let engine = match (url_safe, no_padding) {
        (true, true) => base64::engine::general_purpose::URL_SAFE_NO_PAD,
        (true, false) => base64::engine::general_purpose::URL_SAFE,
        (false, true) => base64::engine::general_purpose::STANDARD_NO_PAD,
        (false, false) => base64::engine::general_purpose::STANDARD,
    };
    engine.encode(data)
}

pub fn base64_decode(text: &str, flags: i64) -> Result<Vec<u8>, String> {
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let url_safe = flags & 8 != 0 || cleaned.contains('-') || cleaned.contains('_');
    let cleaned = if url_safe {
        cleaned.replace('-', "+").replace('_', "/")
    } else {
        cleaned
    };
    let unpadded = cleaned.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(unpadded)
        .map_err(|error| format!("Base64 无法解码：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rc4_matches_the_known_vector() {
        // RFC 6229's classic test: key "Key", plaintext "Plaintext".
        let cipher = SymmetricCrypto::new("rc4", b"Key", None).unwrap();
        let encrypted = cipher.encrypt(b"Plaintext").unwrap();
        assert_eq!(hex::encode(&encrypted), "bbf316e8d940af0ad3");
        assert_eq!(cipher.decrypt(&encrypted).unwrap(), b"Plaintext");
    }

    #[test]
    fn aes_and_des_round_trip_with_known_vectors() {
        let aes = SymmetricCrypto::new(
            "AES/CBC/PKCS5Padding",
            b"0123456789abcdef",
            Some(b"fedcba9876543210"),
        )
        .unwrap();
        let encrypted = aes.encrypt("正文内容".as_bytes()).unwrap();
        assert_eq!(aes.decrypt(&encrypted).unwrap(), "正文内容".as_bytes());
        // openssl enc -aes-128-ecb -K 30313233343536373839616263646566 <<< "hello" (no newline)
        let ecb = SymmetricCrypto::new("AES/ECB/PKCS5Padding", b"0123456789abcdef", None).unwrap();
        assert_eq!(
            base64_encode(&ecb.encrypt(b"hello").unwrap(), 2),
            "Z0x+8454yr2c7JwSWCOmOQ=="
        );
        let des = SymmetricCrypto::new("DES/ECB/PKCS5Padding", b"12345678", None).unwrap();
        let des_text = des.encrypt(b"abc").unwrap();
        assert_eq!(des.decrypt(&des_text).unwrap(), b"abc");
        let tdes = SymmetricCrypto::new(
            "DESede/CBC/PKCS5Padding",
            b"0123456789abcdefghijklmn",
            Some(b"12345678"),
        )
        .unwrap();
        let tdes_text = tdes.encrypt(b"xyz").unwrap();
        assert_eq!(tdes.decrypt(&tdes_text).unwrap(), b"xyz");
    }

    #[test]
    fn hashes_match_reference_values() {
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            hex::encode(digest(b"abc", "SHA-256").unwrap()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex::encode(
                hmac(
                    b"The quick brown fox jumps over the lazy dog",
                    "HmacSHA256",
                    b"key"
                )
                .unwrap()
            ),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn cipher_text_is_hex_or_base64() {
        assert_eq!(decode_cipher_text("616263").unwrap(), b"abc");
        assert_eq!(decode_cipher_text("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("YW Jj\n", 0).unwrap(), b"abc");
    }
}
