use crate::error::{AppError, ErrorCode};
use crate::models::{TxtDecodeState, TxtEncoding};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTxt {
    pub text: String,
    pub detected: TxtEncoding,
    pub selected: TxtEncoding,
    pub state: TxtDecodeState,
}

/// Detect and decode a TXT without silently accepting invalid UTF-8. The
/// caller may persist `selected` and repeat this operation when the reader
/// changes the encoding.
pub fn detect_and_decode(input: &[u8], requested: TxtEncoding) -> Result<DecodedTxt, AppError> {
    let (detected, bytes) = detect_bom(input);
    let effective = if requested == TxtEncoding::Auto {
        detected.clone().unwrap_or_else(|| {
            if std::str::from_utf8(input).is_ok() {
                TxtEncoding::Utf8
            } else {
                detect_legacy(input)
            }
        })
    } else {
        requested.clone()
    };
    let bytes = if requested == TxtEncoding::Auto {
        bytes
    } else {
        strip_bom_for(input, &effective)
    };
    let (text, state) = decode_with_encoding(bytes, &effective)?;
    if requested == TxtEncoding::Auto && state == TxtDecodeState::ReplacementCharacters {
        return Err(AppError::new(
            ErrorCode::UnsupportedEncoding,
            "automatic TXT detection produced replacement characters; choose an encoding manually",
        ));
    }
    Ok(DecodedTxt {
        text: if text.contains('\r') {
            normalize_line_endings(&text)
        } else {
            text
        },
        detected: detected.unwrap_or_else(|| effective.clone()),
        // Keep the user's choice separate from the encoding used by this
        // particular automatic detection pass. This lets the reader display
        // and persist “自动识别” while still reporting the detected encoding.
        selected: requested,
        state,
    })
}

fn detect_bom(input: &[u8]) -> (Option<TxtEncoding>, &[u8]) {
    if let Some(rest) = input.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return (Some(TxtEncoding::Utf8), rest);
    }
    if let Some(rest) = input.strip_prefix(&[0xff, 0xfe]) {
        return (Some(TxtEncoding::Utf16Le), rest);
    }
    if let Some(rest) = input.strip_prefix(&[0xfe, 0xff]) {
        return (Some(TxtEncoding::Utf16Be), rest);
    }
    (None, input)
}

fn strip_bom_for<'a>(input: &'a [u8], encoding: &TxtEncoding) -> &'a [u8] {
    match encoding {
        TxtEncoding::Utf8 => input.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(input),
        TxtEncoding::Utf16Le => input.strip_prefix(&[0xff, 0xfe]).unwrap_or(input),
        TxtEncoding::Utf16Be => input.strip_prefix(&[0xfe, 0xff]).unwrap_or(input),
        _ => input,
    }
}

/// Bytes sampled for legacy encoding detection. Novels are long runs of the
/// same script, so a prefix decides as well as the whole file at a fraction of
/// the cost (Legado samples 512000 bytes). Decoding still covers every byte,
/// and replacement characters anywhere still reject an automatic guess.
const DETECTION_SAMPLE_BYTES: usize = 512 * 1024;

fn detect_legacy(input: &[u8]) -> TxtEncoding {
    let mut detector = chardetng::EncodingDetector::new();
    let sample = &input[..input.len().min(DETECTION_SAMPLE_BYTES)];
    detector.feed(sample, sample.len() == input.len());
    let encoding = detector.guess(None, true);
    match encoding.name().to_ascii_uppercase().as_str() {
        "GBK" | "GB2312" | "GB_2312-80" => TxtEncoding::Gbk,
        "GB18030" => TxtEncoding::Gb18030,
        "UTF-16LE" => TxtEncoding::Utf16Le,
        "UTF-16BE" => TxtEncoding::Utf16Be,
        _ => TxtEncoding::Gb18030,
    }
}

fn decode_with_encoding(
    input: &[u8],
    encoding: &TxtEncoding,
) -> Result<(String, TxtDecodeState), AppError> {
    match encoding {
        TxtEncoding::Auto => unreachable!("auto is resolved before decoding"),
        TxtEncoding::Utf8 => String::from_utf8(input.to_vec())
            .map(|text| (text, TxtDecodeState::Clean))
            .map_err(|error| {
                AppError::new(
                    ErrorCode::UnsupportedEncoding,
                    format!(
                        "TXT is not valid UTF-8 (invalid byte at {})",
                        error.utf8_error().valid_up_to()
                    ),
                )
            }),
        TxtEncoding::Gb18030 => decode_lossy(encoding_rs::GB18030, input),
        TxtEncoding::Gbk => decode_lossy(encoding_rs::GBK, input),
        TxtEncoding::Utf16Le => decode_lossy(encoding_rs::UTF_16LE, input),
        TxtEncoding::Utf16Be => decode_lossy(encoding_rs::UTF_16BE, input),
    }
}

fn decode_lossy(
    encoding: &'static encoding_rs::Encoding,
    input: &[u8],
) -> Result<(String, TxtDecodeState), AppError> {
    let (text, _, had_errors) = encoding.decode(input);
    Ok((
        text.into_owned(),
        if had_errors {
            TxtDecodeState::ReplacementCharacters
        } else {
            TxtDecodeState::Clean
        },
    ))
}

/// Decode an imported TXT as UTF-8, accepting and removing an optional BOM.
pub fn decode_and_normalize(input: &[u8]) -> Result<String, AppError> {
    Ok(detect_and_decode(input, TxtEncoding::Utf8)?.text)
}

/// Convert CRLF and lone CR line endings to LF without changing other text.
pub fn normalize_line_endings(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(position) = rest.find('\r') {
        normalized.push_str(&rest[..position]);
        normalized.push('\n');
        rest = &rest[position + 1..];
        if let Some(after_lf) = rest.strip_prefix('\n') {
            rest = after_lf;
        }
    }
    normalized.push_str(rest);
    normalized
}

/// Return the UTF-16 code-unit length used by ReaderLocator offsets.
pub fn utf16_length(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// Build pairs of valid UTF-16 offsets and UTF-8 byte indexes.
///
/// Every Unicode scalar value contributes one boundary before and after it;
/// this intentionally excludes the middle of a surrogate pair.
pub fn utf16_boundaries(text: &str) -> Vec<(u64, usize)> {
    let mut boundaries = Vec::with_capacity(text.chars().count() + 1);
    let mut offset = 0_u64;
    boundaries.push((offset, 0));

    for (byte_index, character) in text.char_indices() {
        offset += character.len_utf16() as u64;
        boundaries.push((offset, byte_index + character.len_utf8()));
    }

    boundaries
}

pub fn byte_index_for_offset(boundaries: &[(u64, usize)], offset: u64) -> Result<usize, AppError> {
    boundaries
        .binary_search_by_key(&offset, |(boundary, _)| *boundary)
        .map(|index| boundaries[index].1)
        .map_err(|_| {
            AppError::new(
                ErrorCode::InvalidLocator,
                format!("offset {offset} is not a UTF-16 scalar boundary"),
            )
        })
}

/// Find the greatest valid boundary at or before `target`.
pub fn floor_boundary(boundaries: &[(u64, usize)], target: u64) -> (u64, usize) {
    match boundaries.binary_search_by_key(&target, |(boundary, _)| *boundary) {
        Ok(index) => boundaries[index],
        Err(0) => boundaries[0],
        Err(index) => boundaries[index - 1],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bom_and_normalizes_all_line_endings() {
        assert_eq!(
            decode_and_normalize("\u{feff}a\r\nb\rc\n".as_bytes()).unwrap(),
            "a\nb\nc\n"
        );
        assert_eq!(normalize_line_endings("a\r\r\nb"), "a\n\nb");
    }

    #[test]
    fn detects_legacy_encoding_from_a_prefix_and_decodes_every_byte() {
        let text = "第一章 开始\r\n少年望着云海。\r\n".repeat(40_000) + "结尾";
        let (gbk, _, _) = encoding_rs::GBK.encode(&text);
        assert!(gbk.len() > DETECTION_SAMPLE_BYTES);
        let decoded = detect_and_decode(&gbk, TxtEncoding::Auto).unwrap();
        assert!(matches!(
            decoded.detected,
            TxtEncoding::Gbk | TxtEncoding::Gb18030
        ));
        assert!(decoded.text.ends_with("少年望着云海。\n结尾"));
        assert!(!decoded.text.contains('\r'));
    }

    #[test]
    fn rejects_invalid_utf8() {
        let error = decode_and_normalize(&[0xf0, 0x28, 0x8c, 0x28]).unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedEncoding);
    }

    #[test]
    fn tracks_utf16_boundaries_and_rejects_surrogate_middle() {
        let text = "a😀b";
        let boundaries = utf16_boundaries(text);
        assert_eq!(utf16_length(text), 4);
        assert_eq!(byte_index_for_offset(&boundaries, 1).unwrap(), 1);
        assert_eq!(byte_index_for_offset(&boundaries, 3).unwrap(), 5);
        let error = byte_index_for_offset(&boundaries, 2).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidLocator);
        assert_eq!(floor_boundary(&boundaries, 2), (1, 1));
    }

    #[test]
    fn decodes_bom_and_legacy_encodings_without_changing_line_rules() {
        let utf16 = [0xff, 0xfe, b'a', 0, b'\r', 0, b'\n', 0];
        let decoded = detect_and_decode(&utf16, TxtEncoding::Auto).unwrap();
        assert_eq!(decoded.detected, TxtEncoding::Utf16Le);
        assert_eq!(decoded.text, "a\n");
        let gbk = [0xd6, 0xd0, 0xce, 0xc4];
        let decoded = detect_and_decode(&gbk, TxtEncoding::Gbk).unwrap();
        assert_eq!(decoded.text, "中文");
    }
}
