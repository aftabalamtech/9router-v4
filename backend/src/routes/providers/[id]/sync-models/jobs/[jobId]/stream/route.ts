import { getSyncJob, syncJobSnapshot } from "../../../../../../../lib/models/modelSync.js";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/sync-models/jobs/[jobId]/stream - SSE progress.
// Events: "start", "update", "done".
export async function GET(req, res, { params }) {
  const { jobId } = await params;
  const job = getSyncJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Sync job not found or expired" });
  }

  const encoder = new TextEncoder();
  let controllerCleanup = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let keepalive = null;
      const send = (event, payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          cleanup();
        }
      };
      const onUpdate = (snapshot) => send("update", snapshot);
      const onDone = (snapshot) => {
        send("done", snapshot);
        try { controller.close(); } catch {}
        closed = true;
        cleanup();
      };
      const cleanup = () => {
        job.emitter.off("update", onUpdate);
        job.emitter.off("done", onDone);
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
      };

      send("start", syncJobSnapshot(job));
      if (job.status !== "running") {
        onDone(syncJobSnapshot(job));
        return;
      }
      job.emitter.on("update", onUpdate);
      job.emitter.on("done", onDone);
      keepalive = setInterval(() => {
        if (closed) { clearInterval(keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
          cleanup();
        }
      }, 25000);
      req.on?.("close", () => { closed = true; cleanup(); });
      controllerCleanup = () => { closed = true; cleanup(); };
    },
    cancel() {
      try {
        controllerCleanup?.();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
