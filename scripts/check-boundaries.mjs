import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();

function filesUnder(directory, extensions) {
  const absolute = join(root, directory);
  try {
    statSync(absolute);
  } catch {
    return [];
  }

  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (extensions.has(entry.name.split(".").pop())) {
        files.push(path);
      }
    }
  };
  visit(absolute);
  return files;
}

const violations = [];
const frontendFiles = filesUnder("src", new Set(["ts", "tsx"]));
const relativePath = (file) => relative(root, file).split(sep).join("/");
const readerFiles = frontendFiles.filter((file) => relativePath(file).startsWith("src/reader/"));
const serviceFiles = frontendFiles.filter((file) => relativePath(file).startsWith("src/services/"));

for (const file of frontendFiles) {
  const source = readFileSync(file, "utf8");
  const path = relativePath(file);
  if (!path.startsWith("src/services/") && /@tauri-apps\/api|\binvoke\s*\(/.test(source)) {
    violations.push(`${path}: Tauri IPC must be accessed through src/services`);
  }
}

for (const file of readerFiles) {
  const source = readFileSync(file, "utf8");
  const path = relativePath(file);
  if (/@tauri-apps\/api|\binvoke\s*\(|\blisten\s*\(|rusqlite|CREATE\s+TABLE|\.sqlite3/.test(source)) {
    violations.push(`${path}: reader logic must depend on ReaderService, not IPC or storage`);
  }
}

for (const file of serviceFiles) {
  const source = readFileSync(file, "utf8");
  const path = relativePath(file);
  if (!source.includes("@tauri-apps/api")) {
    violations.push(`${path}: service boundary must contain the Tauri adapter`);
  }
}

for (const name of ["models.rs", "storage.rs", "txt.rs"]) {
  const file = join(root, "src-tauri", "src", name);
  try {
    const source = readFileSync(file, "utf8");
    if (/\btauri\b/.test(source)) {
      violations.push(`src-tauri/src/${name}: domain/storage code must not import Tauri`);
    }
  } catch {
    // The command reports missing implementation through the normal build checks.
  }
}

if (violations.length > 0) {
  console.error(violations.map((violation) => `- ${violation}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Dependency boundaries passed.");
}
