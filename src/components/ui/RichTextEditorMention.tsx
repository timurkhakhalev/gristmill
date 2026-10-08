import { mergeAttributes } from "@tiptap/core";
import Mention, { type MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { z } from "zod";
import MentionChip from "./MentionChip";
import MentionSuggestions, {
  type MentionSuggestionItem,
  type MentionSuggestionsHandle,
  type MentionSuggestionsProps,
} from "./MentionSuggestions";
import {
  MENTION_HREF_PREFIX,
  buildMentionMarkdown,
  mentionAttrsSchema,
  parseMentionEmail,
  type MentionPerson,
} from "../../utils/mentionMarkdown";

const SUGGESTION_WIDTH = 240;

const mentionItemSchema = z.object({ label: z.string(), email: z.string().nullable() });

// Only an HTML element can be styled; the suggestion renderer is a DOM node.
function htmlElementOf(renderer: { element: Element } | null): HTMLElement | undefined {
  return renderer?.element instanceof HTMLElement ? renderer.element : undefined;
}

const suggestionRender: SuggestionOptions<
  MentionSuggestionItem,
  MentionNodeAttrs
>["render"] = () => {
  let component: ReactRenderer<MentionSuggestionsHandle, MentionSuggestionsProps> | null = null;

  const position = (clientRect?: (() => DOMRect | null) | null) => {
    const element = htmlElementOf(component);
    const rect = clientRect?.();

    if (!element || !rect) return;
    element.style.position = "fixed";
    element.style.zIndex = "9999";
    element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - SUGGESTION_WIDTH - 8))}px`;
    element.style.top = `${rect.bottom + 6}px`;
  };

  return {
    onStart: (props) => {
      component = new ReactRenderer(MentionSuggestions, {
        props: { items: props.items, command: props.command },
        editor: props.editor,
      });
      document.body.appendChild(component.element);
      position(props.clientRect);
    },
    onUpdate: (props) => {
      if (!component) return;
      const element = htmlElementOf(component);

      if (element) element.style.display = "";
      component.updateProps({ items: props.items, command: props.command });
      position(props.clientRect);
    },
    onKeyDown: (props) => {
      if (props.event.key === "Escape") {
        const element = htmlElementOf(component);

        if (element) element.style.display = "none";

        return true;
      }

      return component?.ref?.onKeyDown(props.event) ?? false;
    },
    onExit: () => {
      component?.element.remove();
      component?.destroy();
      component = null;
    },
  };
};

const toSuggestionItems = (people: MentionPerson[], query: string): MentionSuggestionItem[] => {
  const q = query.toLowerCase();

  return people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
    .slice(0, 6)
    .map((p) => ({ id: p.email ?? p.name, label: p.name, email: p.email }));
};

/**
 * Mention extension that round-trips through tiptap-markdown as a
 * `[@Name](mention:email)` link — see buildMentionMarkdown. `getPeople` is
 * read lazily so suggestions always reflect the latest known people without
 * rebuilding the editor.
 */
export function createMentionExtension(getPeople: () => MentionPerson[]) {
  return Mention.extend({
    addAttributes() {
      return {
        label: { default: "" },
        email: { default: null },
      };
    },
    parseHTML() {
      return [
        {
          tag: `a[href^="${MENTION_HREF_PREFIX}"]`,
          priority: 100,
          getAttrs: (element) => {
            const label = (element.textContent || "").replace(/^@/, "").trim();

            if (!label) return false;

            return { label, email: parseMentionEmail(element.getAttribute("href")) };
          },
        },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const { label, email } = mentionAttrsSchema.parse(node.attrs);

      return [
        "a",
        mergeAttributes(HTMLAttributes, {
          href: `${MENTION_HREF_PREFIX}${encodeURIComponent(email || label)}`,
          "data-mention": "",
        }),
        `@${label}`,
      ];
    },
    renderText({ node }) {
      return `@${mentionAttrsSchema.parse(node.attrs).label}`;
    },
    addNodeView() {
      return ReactNodeViewRenderer(MentionChip);
    },
    addStorage() {
      return {
        markdown: {
          serialize(state: { write: (content: string) => void }, node: NodeViewProps["node"]) {
            const { label, email } = mentionAttrsSchema.parse(node.attrs);
            state.write(buildMentionMarkdown({ name: label, email }));
          },
          parse: {},
        },
      };
    },
  }).configure({
    suggestion: {
      items: ({ query }) => toSuggestionItems(getPeople(), query),
      command: ({ editor, range, props }) => {
        const item = mentionItemSchema.parse(props);
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: "mention", attrs: { label: item.label, email: item.email } },
            { type: "text", text: " " },
          ])
          .run();
      },
      render: suggestionRender,
    },
  });
}
