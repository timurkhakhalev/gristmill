// Keep fast tool results visible long enough to read in the embedded chat.
export const AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS = 2400;

export function getAgentToolActivityRemainingMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS - (now - startedAt));
}
