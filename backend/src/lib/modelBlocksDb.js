// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  getBlockedModels, getBlockedByProvider, blockModels, unblockModels,
} from "../lib/db/index.js";
