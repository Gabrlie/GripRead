// Runs a command with the environment the Android build needs beyond what
// Tauri sets: QuickJS bindings are generated for Android with the NDK's own
// libclang, sysroot, and compiler headers. CLANG_PATH keeps bindgen from
// probing include paths with a system clang (CI runners have one), whose
// headers would shadow the NDK's.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ndk = process.env.NDK_HOME;
if (!ndk) throw new Error("NDK_HOME must point to the Android NDK");
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: node scripts/android.mjs <command> [args...]");

const toolchain = join(ndk, "toolchains", "llvm", "prebuilt", "linux-x86_64");
const clangVersions = readdirSync(join(toolchain, "lib", "clang"));
if (clangVersions.length === 0) throw new Error("the NDK has no clang resource directory");
const headers = join(toolchain, "lib", "clang", clangVersions.sort().at(-1), "include");

const env = {
  ...process.env,
  LIBCLANG_PATH: join(toolchain, "lib"),
  CLANG_PATH: join(toolchain, "bin", "clang"),
  BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: `--sysroot=${join(toolchain, "sysroot")} --target=aarch64-linux-android24 -isystem ${headers}`,
};
const child = spawn(command, args, { env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
