// Point the `zcode-provider` package at the headless ZCode runtime installed
// under ~/tool/zcode (extracted from the official Linux AppImage).
//
// Why this file exists: zcode-provider hardcodes /opt/ZCode (Linux) and
// /Applications/ZCode.app (macOS), and its modern-protocol auto-detection only
// triggers on darwin. A ~/tool install therefore always needs these overrides.
// Shell init (~/.bashrc, ~/.profile) also exports them, but a non-interactive
// shell skips ~/.bashrc, so this module sets them at import time as well.
//
// Everything here is a no-op for anyone with a normal /opt or app-bundle
// install, because existing values always win.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.ZCODE_ROOT ?? join(homedir(), "tool", "zcode");
const ENTRY = join(ROOT, "resources", "glm", "zcode.cjs");
const CATALOG = join(ROOT, "resources", "config", "provider", "zcode-builtin.json");

const setIf = (key: string, value: string) => {
  if (!process.env[key]) process.env[key] = value;
};

if (existsSync(ENTRY)) {
  setIf("ZCODE_SERVE_CMD", `node ${ENTRY} app-server`);
  // AppImage layout = the "modern" catalog (Desktop 3.12+). Custom serve
  // commands otherwise default to the legacy protocol, which fails with
  // "Model not found in Provider Registry".
  setIf("ZCODE_PROTOCOL_VARIANT", "modern");
}
if (existsSync(CATALOG)) setIf("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", CATALOG);
// Billing/discovery header for the Start Plan path (the extension otherwise reads
// it from the macOS Info.plist, which does not exist here). Must match the
// installed ZCode release: ZCODE_ROOT/VERSION if present, else the AppImage version.
const VERSION_FILE = join(ROOT, "VERSION");
const FALLBACK_VERSION = "3.15.3";
setIf(
  "ZCODE_APP_VERSION",
  existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, "utf8").trim() : FALLBACK_VERSION,
);

// The side effect above must happen at import time (before zcode-provider reads
// SERVE_CMD at its own module scope), so this factory stays empty on purpose.
export default function zcodeEnv(): void {}
