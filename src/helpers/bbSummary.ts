import type { BbSelection } from "../contracts/bb.js";
import { BbCliError, getBbThreadHistory, getBbThreadOutput, spawnBbThread, tellBbThread, watchBbThread } from "./bbCli.js";

export async function generateBbSummary(input: {
  prompt: string;
  selection: BbSelection;
  environment: string;
  threadId: string | null;
  saveThreadId: (id: string) => boolean;
  signal: AbortSignal;
}): Promise<string> {
  let id = input.threadId;
  let afterSeq = 0;
  if (id) {
    const history = await getBbThreadHistory(id);
    if (history.completed) {
      const output = await getBbThreadOutput(id);
      if (output.trim()) return output;
    }
    afterSeq = history.sequence;
    if (history.failed || history.completed) {
      await tellBbThread(id, input.prompt, input.signal);
    }
  } else {
    id = await spawnBbThread(input.prompt, input.selection, input.environment, input.signal);
    if (!input.saveThreadId(id)) {
      throw new BbCliError("bb-thread-state-not-saved", "Could not save bb thread ID");
    }
  }
  for await (const _text of watchBbThread(id, input.signal, afterSeq)) { /* wait */ }
  return getBbThreadOutput(id);
}
