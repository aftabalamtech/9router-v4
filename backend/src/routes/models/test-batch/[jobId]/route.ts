import { getJob, jobSnapshot } from "../../../../lib/models/testBatch.js";

// GET /api/models/test-batch/[jobId] - Current snapshot of a batch test job.
export async function GET_handler(req, res, { params }) {
  try {
    const { jobId } = await params;
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: "Test job not found or expired" });
    return res.json(jobSnapshot(job));
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch test job" });
  }
}
