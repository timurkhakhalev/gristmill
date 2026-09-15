// Sender-scoped registry of in-flight abortable requests, keyed by
// (webContents senderId, requestId). One renderer can never abort, replace
// or complete another renderer's request; a repeated id for the same sender
// aborts the previous controller so a replacement always starts fresh, and
// completion is identity-guarded so a late finish never removes a
// replacement. Pure seam: no Electron imports.
export class AgentStreamRequestRegistry {
  private readonly requestsBySender = new Map<number, Map<string, AbortController>>();

  begin(senderId: number, requestId: string): AbortController {
    if (!Number.isInteger(senderId)) {
      throw new TypeError("senderId must be an integer");
    }
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw new TypeError("requestId must be a non-empty string");
    }

    let senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) {
      senderRequests = new Map();
      this.requestsBySender.set(senderId, senderRequests);
    }

    senderRequests.get(requestId)?.abort();
    const controller = new AbortController();
    senderRequests.set(requestId, controller);
    return controller;
  }

  cancel(senderId: number, requestId: string): boolean {
    const senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) return false;
    const controller = senderRequests.get(requestId);
    if (!controller) return false;

    controller.abort();
    senderRequests.delete(requestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
    return true;
  }

  complete(senderId: number, requestId: string, controller: AbortController): void {
    const senderRequests = this.requestsBySender.get(senderId);
    if (senderRequests?.get(requestId) !== controller) return;

    senderRequests.delete(requestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
  }

  /** Whether this exact controller is still the live entry for the id. */
  isActive(senderId: number, requestId: string, controller: AbortController): boolean {
    return this.requestsBySender.get(senderId)?.get(requestId) === controller;
  }

  cancelSender(senderId: number): number {
    const senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) return 0;

    for (const controller of senderRequests.values()) controller.abort();
    const cancelledCount = senderRequests.size;
    this.requestsBySender.delete(senderId);
    return cancelledCount;
  }
}
