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
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      // Actionable, honest warning: with DATABASE_URL set the app's data lives
      // in PostgreSQL and nothing is lost; on SQLite this fallback directory
      // is EPHEMERAL on PaaS containers (data is wiped on redeploy).
      console.warn(
        `[DATA_DIR] '${configured}' is not writable → falling back to ~/.${APP_NAME}. ` +
        (process.env.DATABASE_URL
          ? `DATABASE_URL is set, so application data is stored in PostgreSQL and is NOT affected. `
          : `WARNING: no DATABASE_URL set — SQLite data in this fallback directory will NOT survive container redeploys; attach a persistent disk at '${configured}' or unset DATA_DIR. `)
      );
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
