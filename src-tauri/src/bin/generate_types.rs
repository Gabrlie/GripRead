use std::fs;
use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = manifest_dir.join("../src/types/generated.ts");
    if std::env::args().any(|argument| argument == "--check") {
        let check_root = manifest_dir.join("target/generated-types-check");
        let check_output = check_root.join("generated.ts");
        gripread_lib::typegen::write_generated_types(&check_output)?;
        let actual_dir = output
            .parent()
            .map(|parent| parent.join("generated"))
            .unwrap_or_else(|| PathBuf::from("generated"));
        let expected_dir = check_output
            .parent()
            .map(|parent| parent.join("generated"))
            .unwrap_or_else(|| PathBuf::from("generated"));
        let matches = same_file(&output, &check_output)? && same_tree(&actual_dir, &expected_dir)?;
        let _ = fs::remove_dir_all(&check_root);
        if !matches {
            eprintln!(
                "generated TypeScript bindings are stale: run `pnpm generate:types` ({})",
                output.display()
            );
            std::process::exit(1);
        }
        println!("generated TypeScript bindings are up to date");
    } else {
        gripread_lib::typegen::write_generated_types(&output)?;
        println!("generated {}", output.display());
    }
    Ok(())
}

fn same_file(actual: &Path, expected: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    Ok(fs::read(actual)? == fs::read(expected)?)
}

fn same_tree(actual_root: &Path, expected_root: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    let actual = files_relative_to(actual_root)?;
    let expected = files_relative_to(expected_root)?;
    if actual != expected {
        return Ok(false);
    }
    for relative in actual {
        if fs::read(actual_root.join(&relative))? != fs::read(expected_root.join(&relative))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn files_relative_to(root: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else {
            files.push(path.strip_prefix(root)?.to_path_buf());
        }
    }
    Ok(())
}
