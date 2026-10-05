import type { BbSelection } from "../contracts/bb.js";
import {
  assertBbVersion,
  BbCliError,
  getBbThreadHistory,
  getBbThreadOutput,
  spawnBbThread,
  stopBbThread,
  tellBbThread,
  watchBbThread,
} from "./bbCli.js";
import type { MeetingTextConversation, MeetingTextTurn } from "./meetingSummary.js";
import {
  MEETING_TASKS_INSTRUCTION,
  replaceMeetingTasks,
  replaceMeetingRecap,
  validateMeetingRecap,
} from "./meetingSummarySections.js";

const materialHeaders = [
  "Meeting title (topic hint):",
  "Calendar candidates (not proof of attendance or identity):",
  "Manual notes:",
  "Saved summary (verify against source):",
  "Transcript source run:",
  "Speaker identities (preserve user names; verify model suggestions):",
  "Actual meeting transcript:",
];

const summaryHeader = materialHeaders[3];

const sourceHeader = materialHeaders[4];

const reference = (header: string) =>
  header === summaryHeader
    ? "Use Summary, already created or supplied in this conversation."
    : `Use the unchanged ${header.slice(0, -1).toLowerCase()} already supplied in this conversation.`;

function materialBlocks(
  text: string
): Array<{ header: string; text: string; start: number; end: number }> {
  const matches = [
    ...text.matchAll(
      new RegExp(
        `^(?:${materialHeaders.map((header) => header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\n`,
        "gm"
      )
    ),
  ];

  if (new Set(matches.map((match) => match[0])).size !== matches.length) return [];

  return matches.map((match, index) => {
    const start = match.index! + match[0].length;
    let end = matches[index + 1]?.index ?? text.length;

    while (end > start && text[end - 1] === "\n") end -= 1;

    return { header: match[0].trimEnd(), text: text.slice(start, end), start, end };
  });
}

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
        const previous = new Map<string, string>();
        let lastInput = "";

        const history = await getBbThreadHistory(
          id,
          (text) => {
            lastInput = text;
            const blocks = materialBlocks(text);
            const source = blocks.find((block) => block.header === sourceHeader);

            if (
              source &&
              source.text !== reference(sourceHeader) &&
              previous.get(sourceHeader) !== source.text
            )
              previous.clear();

            for (const block of blocks) {
              if (block.text !== reference(block.header)) previous.set(block.header, block.text);
            }
          },
          (text) => {
            if (!materialBlocks(lastInput).length) return;
            const summary = previous.get(summaryHeader);

            if (lastInput.startsWith(MEETING_TASKS_INSTRUCTION) && summary !== undefined) {
              const updated = replaceMeetingTasks(summary, text);

              if (updated.success) previous.set(summaryHeader, updated.markdown);
            } else {
              const recap = validateMeetingRecap(text);

              if (recap.success && summary !== undefined) {
                const updated = replaceMeetingRecap(summary, recap.value);

                if (updated.success) previous.set(summaryHeader, updated.markdown);
              } else if (
                !lastInput.includes("Allowed output IDs:") &&
                !lastInput.startsWith(MEETING_TASKS_INSTRUCTION) &&
                !recap.success &&
                text.trim()
              ) {
                previous.set(summaryHeader, text.trim());
              }
            }
          },
          () => {
            previous.clear();
            lastInput = "";
          }
        );

        const blocks = materialBlocks(message);
        const source = blocks.find((block) => block.header === sourceHeader);

        if (source && previous.get(sourceHeader) !== source.text) previous.clear();

        for (const block of blocks.reverse()) {
          if (previous.get(block.header) === block.text) {
            message =
              message.slice(0, block.start) + reference(block.header) + message.slice(block.end);
          }
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

      for await (const _text of watchBbThread(id, input.signal, afterSeq)) {
        /* wait */
      }

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
