import { useContext } from "react";
import { MentionParticipantsContext } from "./mentionContext";
import { useLegacyMentionContactId } from "../../hooks/usePersonProfile";
import { parseMentionEmail } from "../../utils/mentionMarkdown";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import PersonAvatar from "./PersonAvatar";
import { mentionAttrsSchema } from "../../utils/mentionMarkdown";

/** Inline chip rendered for a mention node — avatar + name. */
export default function MentionChip({ node }: NodeViewProps) {
  const { label, email, contactId, href } = mentionAttrsSchema.parse(node.attrs);

  const participants = useContext(MentionParticipantsContext);

  const legacyId = useLegacyMentionContactId(
    contactId ? null : parseMentionEmail(href),
    participants
  );

  return (
    <NodeViewWrapper as="span" className="inline-flex items-baseline align-baseline mx-px">
      <span
        data-mention
        title={email ?? undefined}
        className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-default dark:bg-white/6 px-1 py-px text-[0.85em] font-medium leading-tight text-foreground/80 whitespace-nowrap"
      >
        <PersonAvatar
          contactId={contactId ?? legacyId}
          email={null}
          displayName={label}
          size={13}
        />
        {label}
      </span>
    </NodeViewWrapper>
  );
}
