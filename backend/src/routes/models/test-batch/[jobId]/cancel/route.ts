import { cancelTestJob, jobSnapshot } from "../../../../../lib/models/testBatch.js";

// POST /api/models/test-batch/[jobId]/cancel - Stop scheduling new tests in a batch.
export async function POST_handler(req, res, { params }) {
  try {
    const { jobId } = await params;
    const job = cancelTestJob(jobId);
    if (!job) return res.status(404).json({ error: "Test job not found or expired" });
    return res.json({ jobId: job.id, status: job.status, cancelled: job.cancelled });
  } catch (error) {
    return res.status(500).json({ error: "Failed to cancel test job" });
  }
}
