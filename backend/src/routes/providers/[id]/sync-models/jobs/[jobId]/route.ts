import { getSyncJob, syncJobSnapshot } from "../../../../../../lib/models/modelSync.js";

// GET /api/providers/[id]/sync-models/jobs/[jobId] - Snapshot of a sync job.
export async function GET_handler(req, res, { params }) {
  try {
    const { jobId } = await params;
    const job = getSyncJob(jobId);
    if (!job) return res.status(404).json({ error: "Sync job not found or expired" });
    return res.json(syncJobSnapshot(job));
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch sync job" });
  }
}
