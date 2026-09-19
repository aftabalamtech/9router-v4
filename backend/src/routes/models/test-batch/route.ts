import { createTestJob, jobSnapshot, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS } from "../../../lib/models/testBatch.js";

// POST /api/models/test-batch - Start a batch model test job.
// Body: { models: [{ model, kind? } | "alias/model"], concurrency?, timeoutMs? }
export async function POST_handler(req, res) {
  try {
    const { models, concurrency, timeoutMs } = req.body || {};
    if (models !== undefined && !Array.isArray(models)) {
      return res.status(400).json({ error: "models must be an array" });
    }
    const job = await createTestJob({ models, concurrency, timeoutMs });
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      concurrency: job.concurrency,
      timeoutMs: job.timeoutMs,
      total: job.results.length,
      streamUrl: `/api/models/test-batch/${job.id}/stream`,
      defaults: { concurrency: DEFAULT_CONCURRENCY, timeoutMs: DEFAULT_TIMEOUT_MS },
    });
  } catch (error) {
    const statusCode = error?.statusCode === 400 ? 400 : 500;
    return res.status(statusCode).json({ error: statusCode === 400 ? error.message : "Failed to start test batch" });
  }
}
