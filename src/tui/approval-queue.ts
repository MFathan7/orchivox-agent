import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";

interface QueueEntry {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * Presents approval requests one at a time. Parallel workers can ask for the
 * same dangerous action, so a single pending slot would silently drop requests.
 */
export class ApprovalQueue {
  private readonly entries: QueueEntry[] = [];
  private activeId: string | undefined;

  enqueue(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.entries.push({ request, resolve });
      if (this.activeId === undefined) this.activeId = request.id;
    });
  }

  current(): ApprovalRequest | undefined {
    return this.entries.find((entry) => entry.request.id === this.activeId)?.request;
  }

  pendingRequests(): ApprovalRequest[] {
    return this.entries.map((entry) => entry.request);
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const index = this.entries.findIndex((entry) => entry.request.id === id);
    if (index === -1) return false;
    const entry = this.entries[index];
    if (!entry) return false;
    this.entries.splice(index, 1);
    if (this.activeId === id) this.activeId = this.entries[0]?.request.id;
    entry.resolve(decision);
    return true;
  }

  cancelForWorker(workerId: string, reason = "worker stopped"): number {
    let cancelled = 0;
    for (const entry of [...this.entries]) {
      if (entry.request.workerId !== workerId) continue;
      if (this.resolve(entry.request.id, { approved: false, choice: "deny", reason })) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancelAll(reason = "cancelled"): number {
    let cancelled = 0;
    for (const entry of [...this.entries]) {
      if (this.resolve(entry.request.id, { approved: false, choice: "deny", reason })) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  pendingCount(): number {
    return this.entries.length;
  }
}
