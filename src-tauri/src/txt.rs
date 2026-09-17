use crate::error::{AppError, ErrorCode};

/// Decode an imported TXT as UTF-8, accepting and removing an optional BOM.
pub fn decode_and_normalize(input: &[u8]) -> Result<String, AppError> {
    let input = input.strip_prefix(b"\xef\xbb\xbf").unwrap_or(input);
    let text = String::from_utf8(input.to_vec()).map_err(|error| {
        AppError::new(
            ErrorCode::UnsupportedEncoding,
            format!(
                "TXT must be valid UTF-8 (invalid byte at {})",
                error.utf8_error().valid_up_to()
            ),
        )
    })?;

    Ok(normalize_line_endings(&text))
}

/// Convert CRLF and lone CR line endings to LF without changing other text.
pub fn normalize_line_endings(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut pending_cr = false;

    for character in text.chars() {
        if pending_cr {
            if character == '\n' {
                normalized.push('\n');
                pending_cr = false;
                continue;
            }
            normalized.push('\n');
            pending_cr = false;
        }

        if character == '\r' {
            pending_cr = true;
        } else {
            normalized.push(character);
        }
    }

    if pending_cr {
        normalized.push('\n');
    }

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
}
