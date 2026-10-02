import { randomUUID } from "node:crypto";
import type {
  CompanionBinding,
  CompanionCandidate,
  CompanionCandidateKey,
  CompanionContext,
  CompanionRecordingScope,
  CompanionStatus,
} from "../contracts/companion.js";

export const COMPANION_CONTEXT_TTL_MS = 5_000;
export const COMPANION_REMINDER_MS = 5 * 60_000;
const sameScope = (a: CompanionRecordingScope | null, b: CompanionRecordingScope) =>
  a?.recordingId === b.recordingId && a.sessionId === b.sessionId;
const sameCandidate = (a: CompanionCandidateKey, b: CompanionCandidateKey) =>
  a.connectionId === b.connectionId &&
  a.ref.installationId === b.ref.installationId &&
  a.ref.sessionId === b.ref.sessionId &&
  a.ref.tabId === b.ref.tabId &&
  a.ref.documentId === b.ref.documentId &&
  a.ref.callId === b.ref.callId;
const keyFor = (key: CompanionCandidateKey) =>
  JSON.stringify([
    key.connectionId,
    key.ref.installationId,
    key.ref.sessionId,
    key.ref.tabId,
    key.ref.documentId,
    key.ref.callId,
  ]);

interface Dependencies {
  now(): number;
  currentScope(): CompanionRecordingScope | null;
  canBind(scope: CompanionRecordingScope): boolean;
  suppressAutoEnd(scope: CompanionRecordingScope): void;
  setPlatformMuted(scope: CompanionRecordingScope, muted: boolean): void;
  leave(binding: CompanionBinding): void;
  remind(scope: CompanionRecordingScope): void;
  changed(status: CompanionStatus): void;
  observe?(binding: CompanionBinding, context: CompanionContext): void;
}

/** Main owns binding and deadlines. Call tick from one owned timer and on resume. */
export class CompanionCoordinator {
  private enabled = true;
  private candidates = new Map<string, CompanionCandidate>();
  private binding: CompanionBinding | null = null;
  private retiredDocuments = new Set<string>();
  private unavailableSince: number | null = null;
  private contextReason: string | null = null;
  private reminderShown = false;
  private leaveClaimed = false;
  constructor(private readonly deps: Dependencies) {}

  status(): CompanionStatus {
    return {
      enabled: this.enabled,
      candidates: this.freshCandidates(),
      binding: this.binding,
      contextUnavailableSince: this.unavailableSince,
      contextReason: this.contextReason,
      reminderShown: this.reminderShown,
    };
  }
  private freshCandidates(): CompanionCandidate[] {
    if (!this.enabled) return [];
    const now = this.deps.now();
    return [...this.candidates.values()].filter(
      (candidate) =>
        now - candidate.receivedAt <= COMPANION_CONTEXT_TTL_MS &&
        candidate.context.health === "recognized" &&
        candidate.context.presence === "in-call" &&
        !candidate.context.confirmedLeave
    );
  }
  private publish(): void {
    this.deps.changed(this.status());
  }
  private currentBinding(): CompanionBinding | null {
    return this.binding && sameScope(this.deps.currentScope(), this.binding) ? this.binding : null;
  }
  receive(key: CompanionCandidateKey, context: CompanionContext): void {
    if (!this.enabled || this.retiredDocuments.has(`${key.connectionId}/${key.ref.documentId}`))
      return;
    const previous = this.candidates.get(keyFor(key));
    if (previous && BigInt(context.sourceNs) <= BigInt(previous.context.sourceNs)) return;
    if (
      previous &&
      this.currentBinding() &&
      sameCandidate(this.currentBinding()!, key) &&
      this.deps.now() - previous.receivedAt > COMPANION_CONTEXT_TTL_MS
    )
      this.markUnavailable();
    const candidate = { ...key, context, receivedAt: this.deps.now() };
    // A tab has one current document/call. Do not leave stale selectable documents.
    for (const [id, previous] of this.candidates) {
      if (previous.connectionId === key.connectionId && previous.ref.tabId === key.ref.tabId) {
        if (previous.ref.documentId !== key.ref.documentId)
          this.retiredDocuments.add(`${previous.connectionId}/${previous.ref.documentId}`);
        this.candidates.delete(id);
      }
    }
    if (this.retiredDocuments.size > 256)
      this.retiredDocuments.delete(this.retiredDocuments.values().next().value!);
    if (this.candidates.size >= 128) this.candidates.delete(this.candidates.keys().next().value!);
    this.candidates.set(keyFor(key), candidate);
    const binding = this.currentBinding();
    if (
      binding &&
      !sameCandidate(binding, key) &&
      !this.leaveClaimed &&
      candidate.context.presence === "in-call" &&
      candidate.context.health === "recognized" &&
      binding.ref.installationId === key.ref.installationId &&
      binding.ref.sessionId === key.ref.sessionId &&
      binding.ref.tabId === key.ref.tabId &&
      binding.ref.callId === key.ref.callId &&
      !this.candidates.has(keyFor(binding))
    ) {
      this.binding = {
        ...binding,
        connectionId: key.connectionId,
        ref: key.ref,
        generation: binding.generation + 1,
      };
      this.unavailableSince = null;
      this.contextReason = null;
      this.reminderShown = false;
    }
    if (this.currentBinding() && sameCandidate(this.currentBinding()!, key)) this.apply(candidate);
    this.publish();
  }
  start(scope: CompanionRecordingScope, restartCall?: CompanionCandidateKey | null): void {
    this.binding = null;
    this.unavailableSince = null;
    this.contextReason = null;
    this.reminderShown = false;
    this.leaveClaimed = false;
    const candidates = this.freshCandidates();
    // Explicit null marks Restart without a former call: never pick a different call.
    const eligible =
      restartCall === undefined
        ? candidates
        : restartCall === null
          ? []
          : candidates.filter((candidate) => sameCandidate(candidate, restartCall));
    if (eligible.length === 1) this.bind(scope, eligible[0]);
    this.publish();
  }
  confirm(scope: CompanionRecordingScope, key: CompanionCandidateKey): boolean {
    if (
      this.leaveClaimed ||
      !this.enabled ||
      !sameScope(this.deps.currentScope(), scope) ||
      !this.deps.canBind(scope)
    )
      return false;
    const candidate = this.freshCandidates().find((value) => sameCandidate(value, key));
    if (!candidate) return false;
    this.bind(scope, candidate);
    this.publish();
    return true;
  }
  private bind(scope: CompanionRecordingScope, candidate: CompanionCandidate): void {
    if (!sameScope(this.deps.currentScope(), scope) || !this.deps.canBind(scope)) return;
    this.unavailableSince = null;
    this.contextReason = null;
    this.reminderShown = false;
    this.leaveClaimed = false;
    this.binding = {
      ...scope,
      connectionId: candidate.connectionId,
      ref: candidate.ref,
      id: randomUUID(),
      generation: 0,
    };
    this.deps.suppressAutoEnd(scope);
    this.apply(candidate);
  }
  private apply(candidate: CompanionCandidate): void {
    const binding = this.currentBinding();
    if (!binding || this.leaveClaimed) return;
    if (candidate.context.health !== "recognized") {
      this.markUnavailable(candidate.context.reason ?? "meet-ui-unrecognized");
      return;
    }
    if (candidate.context.confirmedLeave && candidate.context.presence === "not-in-call") {
      this.leaveClaimed = true;
      this.deps.leave(binding);
      return;
    }
    if (candidate.context.presence !== "in-call") {
      this.markUnavailable();
      return;
    }
    if (this.unavailableSince !== null)
      this.binding = { ...binding, generation: binding.generation + 1 };
    this.unavailableSince = null;
    this.contextReason = null;
    this.reminderShown = false;
    if (candidate.context.mode === "standard" && candidate.context.micMuted !== null) {
      this.deps.setPlatformMuted(binding, candidate.context.micMuted);
    }
    this.deps.observe?.(this.binding!, candidate.context);
  }
  private markUnavailable(reason = "meet-context-unavailable"): void {
    this.contextReason = reason;
    if (this.unavailableSince === null) this.unavailableSince = this.deps.now();
  }
  disconnect(connectionId: string): void {
    for (const [id, candidate] of this.candidates)
      if (candidate.connectionId === connectionId) this.candidates.delete(id);
    if (this.currentBinding()?.connectionId === connectionId) this.markUnavailable();
    this.publish();
  }
  tick(): void {
    const binding = this.currentBinding();
    if (!binding || !this.enabled || this.leaveClaimed) return;
    const candidate = this.candidates.get(keyFor(binding));
    if (!candidate || this.deps.now() - candidate.receivedAt > COMPANION_CONTEXT_TTL_MS)
      this.markUnavailable();
    if (
      this.unavailableSince !== null &&
      !this.reminderShown &&
      this.deps.now() - this.unavailableSince >= COMPANION_REMINDER_MS
    ) {
      this.reminderShown = true;
      this.deps.remind(binding);
    }
    this.publish();
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.candidates.clear();
    const binding = this.currentBinding();
    if (!enabled) {
      if (binding) this.deps.setPlatformMuted(binding, false);
      this.unavailableSince = null;
      this.contextReason = null;
      this.reminderShown = false;
    } else if (binding) this.markUnavailable();
    // Suppression belongs to the recording and is deliberately never undone here.
    this.publish();
  }
  stop(scope: CompanionRecordingScope): void {
    if (!sameScope(this.binding, scope)) return;
    this.binding = null;
    this.unavailableSince = null;
    this.contextReason = null;
    this.reminderShown = false;
    this.leaveClaimed = false;
    this.publish();
  }
}
