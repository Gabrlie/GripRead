import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
export function checkBoundaries(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(file)) files.push(file);
    }
  }
  walk(resolve(root, "src"));
  const errors = [];
  for (const file of files) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (path.includes("/types/generated")) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const specifiers = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
        else errors.push(`${path}: dynamic module paths cannot be boundary-checked`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of specifiers) {
      const local = specifier.startsWith("@/")
        ? specifier.replace("@/", "src/")
        : specifier.startsWith(".")
          ? relative(root, resolve(dirname(file), specifier)).replaceAll("\\", "/")
          : specifier;
      if (specifier.startsWith("@tauri-apps/") && !path.startsWith("src/services/"))
        errors.push(`${path}: native APIs belong in services`);
      if (
        path.startsWith("src/reader/") &&
        /^(src\/(components|context|application)|react(?:\/|$)|@tauri-apps)/.test(local)
      )
        errors.push(`${path}: reading logic cannot depend on presentation or native APIs`);
      if (
        /^src\/(components|context|App)/.test(path) &&
        !/\.test\.[cm]?[jt]sx?$/.test(path) &&
        /^src\/(data|fixtures|test)/.test(local)
      )
        errors.push(`${path}: production pages cannot import test or mock data`);
    }
  }
  // The core serves every shell (the app, the server); it names no platform.
  const core = resolve(root, "crates/core/Cargo.toml");
  if (existsSync(core) && /^\s*tauri[\w-]*\s*=/m.test(readFileSync(core, "utf8")))
    errors.push("crates/core/Cargo.toml: the core cannot depend on Tauri");
  // The source engine runs untrusted rules and scripts; it stays free of the
  // application's IPC.
  const engine = resolve(root, "crates/core/src/sources");
  const engineFiles = [];
  function walkRust(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory()) walkRust(file);
      else if (file.endsWith(".rs")) engineFiles.push(file);
    }
  }
  if (existsSync(engine)) walkRust(engine);
  for (const file of engineFiles)
    if (/\btauri\b/.test(readFileSync(file, "utf8")))
      errors.push(
        `${relative(root, file).replaceAll("\\", "/")}: the source engine cannot depend on Tauri`,
      );
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkBoundaries(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Dependency boundaries passed.");
}
