//! Relocate normalized TXT positions only through verified source-byte boundaries.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use encoding_rs::{DecoderResult, Encoding};

use crate::error::{AppError, ErrorCode};
use crate::models::{TxtDecodeState, TxtEncoding};
use crate::txt;

/// Map valid UTF-16 scalar boundaries through the immutable original bytes.
///
/// No textual similarity or nearest-boundary fallback is used. In particular,
/// a byte boundary inside a differently decoded scalar or a CRLF pair has no
/// destination. Malformed decoding or an unverified source leaves every input
/// offset unresolved. Memory used for boundary lookup depends on the requested
/// offsets, not on the length of the book; each decoder traverses the input once.
pub(crate) fn map_offsets(
    input: &[u8],
    old_encoding: TxtEncoding,
    new_encoding: TxtEncoding,
    old_text: &str,
    new_text: &str,
    offsets: &[u64],
    cancel: &AtomicBool,
) -> Result<Vec<Option<u64>>, AppError> {
    check_cancelled(cancel)?;
    let unresolved = || vec![None; offsets.len()];
    if offsets.is_empty() {
        return Ok(Vec::new());
    }
    let Some(old_plan) = verified_decoder(input, old_encoding, old_text, cancel)? else {
        return Ok(unresolved());
    };
    let Some(new_plan) = verified_decoder(input, new_encoding, new_text, cancel)? else {
        return Ok(unresolved());
    };

    let mut requested: HashMap<u64, Vec<usize>> = HashMap::new();
    for (index, &offset) in offsets.iter().enumerate() {
        if index % 4096 == 0 {
            check_cancelled(cancel)?;
        }
        requested.entry(offset).or_default().push(index);
    }
    let mut raw_anchors: HashMap<usize, Vec<usize>> = HashMap::new();
    if !scan_boundaries(input, old_plan, old_text, cancel, |offset, raw| {
        if let Some(indices) = requested.remove(&offset) {
            raw_anchors.insert(raw, indices);
        }
    })? {
        return Ok(unresolved());
    }

    let mut result = unresolved();
    if !scan_boundaries(input, new_plan, new_text, cancel, |offset, raw| {
        if let Some(indices) = raw_anchors.remove(&raw) {
            for index in indices {
                result[index] = Some(offset);
            }
        }
    })? {
        return Ok(unresolved());
    }
    check_cancelled(cancel)?;
    Ok(result)
}

struct DecodePlan {
    encoding: &'static Encoding,
    start: usize,
}

/// The existing decoder remains authoritative for detection, normalized text,
/// and replacement detection. Resolve its exact BOM handling for the streaming
/// pass; that pass also verifies every normalized scalar against its output.
fn verified_decoder(
    input: &[u8],
    requested: TxtEncoding,
    expected: &str,
    cancel: &AtomicBool,
) -> Result<Option<DecodePlan>, AppError> {
    check_cancelled(cancel)?;
    let decoded = txt::detect_and_decode(input, requested.clone());
    check_cancelled(cancel)?;
    let decoded = match decoded {
        Ok(decoded) => decoded,
        Err(error) if error.code == ErrorCode::UnsupportedEncoding => return Ok(None),
        Err(error) => return Err(error),
    };
    if decoded.state != TxtDecodeState::Clean || decoded.text != expected {
        return Ok(None);
    }
    let effective = if requested == TxtEncoding::Auto {
        decoded.detected
    } else {
        requested
    };
    let encoding = match effective {
        TxtEncoding::Utf8 => encoding_rs::UTF_8,
        TxtEncoding::Utf16Le => encoding_rs::UTF_16LE,
        TxtEncoding::Utf16Be => encoding_rs::UTF_16BE,
        TxtEncoding::Gbk => encoding_rs::GBK,
        TxtEncoding::Gb18030 => encoding_rs::GB18030,
        TxtEncoding::Auto => return Ok(None),
    };
    let mut start = match effective {
        TxtEncoding::Utf8 if input.starts_with(&[0xef, 0xbb, 0xbf]) => 3,
        TxtEncoding::Utf16Le if input.starts_with(&[0xff, 0xfe]) => 2,
        TxtEncoding::Utf16Be if input.starts_with(&[0xfe, 0xff]) => 2,
        _ => 0,
    };
    // txt uses strict String::from_utf8 for UTF-8, but encoding_rs::decode
    // (including its cross-encoding BOM sniffing) for every other encoding.
    let encoding = if effective != TxtEncoding::Utf8 {
        if let Some((actual, length)) = Encoding::for_bom(&input[start..]) {
            start += length;
            actual
        } else {
            encoding
        }
    } else {
        encoding
    };
    Ok(Some(DecodePlan { encoding, start }))
}

fn scan_boundaries(
    input: &[u8],
    plan: DecodePlan,
    expected: &str,
    cancel: &AtomicBool,
    mut visit: impl FnMut(u64, usize),
) -> Result<bool, AppError> {
    check_cancelled(cancel)?;
    let mut decoder = plan.encoding.new_decoder_without_bom_handling();
    let mut expected = expected.chars();
    let mut offset = 0;
    visit(offset, plan.start);
    let mut emit = |character: char, raw_end: usize| {
        if expected.next() != Some(character) {
            return false;
        }
        offset += character.len_utf16() as u64;
        visit(offset, raw_end);
        true
    };
    let mut pending_cr = None;
    // Single-byte incremental input gives exact raw boundaries without
    // decoding prefixes repeatedly. Supported decoders emit at most one
    // scalar for one byte of clean input, even across a UTF-16 surrogate pair.
    for raw in plan.start..input.len() {
        if raw % 4096 == 0 {
            check_cancelled(cancel)?;
        }
        let mut output = [0_u8; 8];
        let (status, read, written) = decoder.decode_to_utf8_without_replacement(
            &input[raw..raw + 1],
            &mut output,
            raw + 1 == input.len(),
        );
        if status != DecoderResult::InputEmpty || read != 1 {
            return Ok(false);
        }
        let Ok(text) = std::str::from_utf8(&output[..written]) else {
            return Ok(false);
        };
        let mut characters = text.chars();
        let Some(character) = characters.next() else {
            continue;
        };
        if characters.next().is_some() {
            return Ok(false);
        }
        if let Some(cr_end) = pending_cr.take() {
            if character == '\n' {
                if !emit('\n', raw + 1) {
                    return Ok(false);
                }
                continue;
            }
            if !emit('\n', cr_end) {
                return Ok(false);
            }
        }
        if character == '\r' {
            pending_cr = Some(raw + 1);
        } else if !emit(character, raw + 1) {
            return Ok(false);
        }
    }
    if let Some(cr_end) = pending_cr {
        if !emit('\n', cr_end) {
            return Ok(false);
        }
    }
    check_cancelled(cancel)?;
    Ok(expected.next().is_none())
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new(
            ErrorCode::ImportCancelled,
            "TXT position relocation cancelled",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(
        input: &[u8],
        old: TxtEncoding,
        new: TxtEncoding,
        offsets: &[u64],
    ) -> Vec<Option<u64>> {
        let old_text = txt::detect_and_decode(input, old.clone()).unwrap().text;
        let new_text = txt::detect_and_decode(input, new.clone()).unwrap().text;
        map_offsets(
            input,
            old,
            new,
            &old_text,
            &new_text,
            offsets,
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    #[test]
    fn preserves_normalized_bom_newline_and_scalar_boundaries_in_original_order() {
        let input = "\u{feff}中\r\n😀\r文\n\r".as_bytes();
        assert_eq!(
            mapped(
                input,
                TxtEncoding::Auto,
                TxtEncoding::Utf8,
                &[8, 0, 1, 2, 3, 4, 5, 6, 7, 2, 9]
            ),
            vec![
                Some(8),
                Some(0),
                Some(1),
                Some(2),
                None,
                Some(4),
                Some(5),
                Some(6),
                Some(7),
                Some(2),
                None
            ]
        );
    }

    #[test]
    fn maps_only_coincident_raw_boundaries_between_utf8_and_gbk() {
        assert_eq!(
            mapped(
                "中文A".as_bytes(),
                TxtEncoding::Utf8,
                TxtEncoding::Gbk,
                &[0, 1, 2, 3]
            ),
            vec![Some(0), None, Some(3), Some(4)]
        );
        assert_eq!(
            mapped(
                "中文A".as_bytes(),
                TxtEncoding::Gbk,
                TxtEncoding::Utf8,
                &[0, 1, 2, 3, 4]
            ),
            vec![Some(0), None, None, Some(2), Some(3)]
        );
    }

    #[test]
    fn maps_utf16_endian_changes_and_excludes_surrogate_middle() {
        let input = [0x3d, 0xd8, 0x00, 0xde, b'A', 0];
        assert_eq!(
            mapped(
                &input,
                TxtEncoding::Utf16Le,
                TxtEncoding::Utf16Be,
                &[0, 1, 2, 3]
            ),
            vec![Some(0), None, Some(2), Some(3)]
        );
        let input = [0, b'A', 0, b'\r', 0, b'\n', 0, b'B'];
        assert_eq!(
            mapped(
                &input,
                TxtEncoding::Utf16Be,
                TxtEncoding::Utf16Le,
                &[0, 1, 2, 3]
            ),
            vec![Some(0), Some(1), Some(3), Some(4)]
        );
        // The reverse boundary between CR and LF is not a normalized anchor.
        assert_eq!(
            mapped(
                &input,
                TxtEncoding::Utf16Le,
                TxtEncoding::Utf16Be,
                &[0, 1, 2, 3, 4]
            ),
            vec![Some(0), Some(1), None, Some(2), Some(3)]
        );
    }

    #[test]
    fn respects_encoding_rs_bom_override_for_explicit_legacy_choices() {
        let input = [0xff, 0xfe, b'A', 0, b'\r', 0, b'\n', 0];
        assert_eq!(
            mapped(&input, TxtEncoding::Gbk, TxtEncoding::Utf16Be, &[0, 1, 2]),
            vec![Some(0), Some(1), Some(2)]
        );
        assert_eq!(
            mapped(
                "\u{feff}中😀".as_bytes(),
                TxtEncoding::Gbk,
                TxtEncoding::Utf8,
                &[0, 1, 2, 3]
            ),
            vec![Some(0), Some(1), None, Some(3)]
        );
    }

    #[test]
    fn supports_gb18030_four_byte_scalars_and_literal_replacement_characters() {
        let (input, _, errors) = encoding_rs::GB18030.encode("中😀\r\n文");
        assert!(!errors);
        assert_eq!(
            mapped(
                &input,
                TxtEncoding::Gb18030,
                TxtEncoding::Gb18030,
                &[0, 1, 2, 3, 4, 5]
            ),
            vec![Some(0), Some(1), None, Some(3), Some(4), Some(5)]
        );
        assert_eq!(
            mapped(
                "�".as_bytes(),
                TxtEncoding::Utf8,
                TxtEncoding::Utf8,
                &[0, 1]
            ),
            vec![Some(0), Some(1)]
        );
    }

    #[test]
    fn rejects_replacement_decodes_and_unverified_text_without_guessing() {
        let cancel = AtomicBool::new(false);
        assert_eq!(
            map_offsets(
                &[0x81],
                TxtEncoding::Gbk,
                TxtEncoding::Gb18030,
                "�",
                "�",
                &[0, 1],
                &cancel
            )
            .unwrap(),
            vec![None, None]
        );
        assert_eq!(
            map_offsets(
                b"ABC",
                TxtEncoding::Utf8,
                TxtEncoding::Utf8,
                "ABD",
                "ABC",
                &[0, 1],
                &cancel
            )
            .unwrap(),
            vec![None, None]
        );
        assert_eq!(
            map_offsets(
                b"ABC",
                TxtEncoding::Utf8,
                TxtEncoding::Utf8,
                "ABC",
                "AB",
                &[0, 1],
                &cancel
            )
            .unwrap(),
            vec![None, None]
        );
        assert_eq!(
            map_offsets(
                &[0xff],
                TxtEncoding::Utf8,
                TxtEncoding::Gbk,
                "",
                "",
                &[0],
                &cancel
            )
            .unwrap(),
            vec![None]
        );
    }

    #[test]
    fn supports_empty_and_bom_only_sources_without_inventing_offsets() {
        assert_eq!(
            mapped(b"", TxtEncoding::Utf8, TxtEncoding::Auto, &[0, 1]),
            vec![Some(0), None]
        );
        assert_eq!(
            mapped(
                &[0xff, 0xfe],
                TxtEncoding::Auto,
                TxtEncoding::Utf16Le,
                &[0, 1]
            ),
            vec![Some(0), None]
        );
    }

    #[test]
    fn matches_automatic_legacy_detection_and_repeated_bom_handling() {
        let (input, _, errors) = encoding_rs::GB18030.encode("中文\r\n😀\r");
        assert!(!errors);
        assert_eq!(
            mapped(
                &input,
                TxtEncoding::Auto,
                TxtEncoding::Gb18030,
                &[0, 1, 2, 3, 4, 5, 6]
            ),
            vec![Some(0), Some(1), Some(2), Some(3), None, Some(5), Some(6)]
        );
        // UTF-8 removes one BOM through the strict path. UTF-16 also
        // passes through encoding_rs BOM removal after txt removes one.
        assert_eq!(
            mapped(
                "\u{feff}\u{feff}A".as_bytes(),
                TxtEncoding::Auto,
                TxtEncoding::Utf8,
                &[0, 1, 2]
            ),
            vec![Some(0), Some(1), Some(2)]
        );
        let input = [0xff, 0xfe, 0xff, 0xfe, b'A', 0];
        assert_eq!(
            mapped(&input, TxtEncoding::Auto, TxtEncoding::Utf16Le, &[0, 1]),
            vec![Some(0), Some(1)]
        );
    }

    #[test]
    fn maps_sparse_positions_in_a_million_character_source() {
        let input = "中文😀\r\n".repeat(250_000);
        assert_eq!(
            mapped(
                input.as_bytes(),
                TxtEncoding::Utf8,
                TxtEncoding::Auto,
                &[0, 500_000, 500_003, 1_250_000, 1_250_001]
            ),
            vec![Some(0), Some(500_000), None, Some(1_250_000), None]
        );
    }

    #[test]
    fn cancellation_is_an_error_before_and_during_boundary_scanning() {
        let cancel = AtomicBool::new(true);
        assert_eq!(
            map_offsets(
                b"abc",
                TxtEncoding::Utf8,
                TxtEncoding::Utf8,
                "abc",
                "abc",
                &[0],
                &cancel
            )
            .unwrap_err()
            .code,
            ErrorCode::ImportCancelled
        );
        cancel.store(false, Ordering::Relaxed);
        let plan = DecodePlan {
            encoding: encoding_rs::UTF_8,
            start: 0,
        };
        assert_eq!(
            scan_boundaries(b"abc", plan, "abc", &cancel, |_, _| cancel
                .store(true, Ordering::Relaxed))
            .unwrap_err()
            .code,
            ErrorCode::ImportCancelled
        );
    }
}
