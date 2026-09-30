import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router-v3";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    // accessSync can report writable for root even on read-only mounts. Verify
    // actual creation, then remove probe file before using configured path.
    const probe = path.join(configured, `.9router-write-test-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(probe, "wx", 0o600);
    fs.closeSync(fd);
    fs.unlinkSync(probe);
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(
        `[DATA_DIR] '${configured}' is not writable → falling back to ${defaultDir()}. ` +
        `Filesystem-backed state, secrets, and SQLite will use this fallback; ` +
        `PostgreSQL does not persist those files. Fix mount ownership/permissions or set a writable DATA_DIR.`
      );
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
