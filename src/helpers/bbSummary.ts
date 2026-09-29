import type { BbSelection } from "../contracts/bb.js";
import { assertBbVersion, BbCliError, getBbThreadHistory, getBbThreadOutput, spawnBbThread, stopBbThread, tellBbThread, watchBbThread } from "./bbCli.js";
import type { MeetingTextConversation, MeetingTextTurn } from "./meetingSummary.js";

export async function createBbTextConversation(input: {
  selection: BbSelection;
  environment: string;
  threadId: string | null;
  promptPrefix?: string;
  saveThreadId: (id: string) => boolean;
  signal: AbortSignal;
}): Promise<MeetingTextConversation> {
  let id = input.threadId;
  return {
    send: async (prompt): Promise<MeetingTextTurn> => {
      let message = input.promptPrefix ? `${input.promptPrefix}\n\n${prompt}` : prompt;
      let afterSeq = 0;
      if (id) {
        await assertBbVersion();
        let previousTranscript: string | undefined;
        const history = await getBbThreadHistory(id, (text) => {
          const transcript = [...text.matchAll(/Actual meeting transcript:\n(<transcript>[\s\S]*?<\/transcript>)/g)].at(-1)?.[1];
          if (transcript) previousTranscript = transcript;
        });
        const transcript = [...message.matchAll(/Actual meeting transcript:\n(<transcript>[\s\S]*?<\/transcript>)/g)].at(-1)?.[1];
        if (transcript && transcript === previousTranscript) {
          const offset = message.lastIndexOf(transcript);
          message = message.slice(0, offset) + "Use the unchanged transcript already supplied in this conversation, with the accepted speaker identities above." + message.slice(offset + transcript.length);
        }
        afterSeq = history.sequence;
        await tellBbThread(id, message, input.signal);
      } else {
        id = await spawnBbThread(message, input.selection, input.environment, input.signal);
        if (!input.saveThreadId(id)) {
          await stopBbThread(id).catch(() => {});
          throw new BbCliError("bb-thread-state-not-saved", "Could not save bb thread ID");
        }
      }
      for await (const _text of watchBbThread(id, input.signal, afterSeq)) { /* wait */ }
      return { text: await getBbThreadOutput(id), refusal: false };
    },
  };
}

export async function generateBbSummary(input: {
  prompt: string;
  selection: BbSelection;
  environment: string;
  threadId: string | null;
  saveThreadId: (id: string) => boolean;
  signal: AbortSignal;
}): Promise<string> {
  const conversation = await createBbTextConversation(input);
  return (await conversation.send(input.prompt)).text;
}
