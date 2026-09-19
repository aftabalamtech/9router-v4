import { cancelSyncJob } from "../../../../../../../lib/models/modelSync.js";

// POST /api/providers/[id]/sync-models/jobs/[jobId]/cancel - Cancel a running sync.
export async function POST_handler(req, res, { params }) {
  try {
    const { jobId } = await params;
    const job = cancelSyncJob(jobId);
    if (!job) return res.status(404).json({ error: "Sync job not found or expired" });
    return res.json({ jobId: job.id, status: job.status, cancelled: job.cancelled });
  } catch (error) {
    return res.status(500).json({ error: "Failed to cancel sync job" });
  }
}
