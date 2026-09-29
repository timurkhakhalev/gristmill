import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReasoningService, { type AgentStreamChunk } from "../../services/ReasoningService";
import { isEnterpriseProvider } from "../../models/ModelRegistry";
import {
  getSettings,
  useSettingsStore,
} from "../../stores/settingsStore";
import { selectResolvedLLMConfig } from "../../config/settingsSelectors";
import { appendDictionarySuffix, getAgentSystemPrompt } from "../../config/prompts";
import { getDictionaryHintWords } from "../../utils/snippets";
import { createToolRegistry } from "../../services/tools";
import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { getAgentToolActivityRemainingMs } from "../../helpers/agentToolPresentation";
import type { Message, AgentState, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";

const LOCAL_TOOL_MIN_PARAMS_B = 4;

export interface ChatSendOptions {
  /** Complete system prompt for a one-off action in the existing conversation. */
  systemPrompt?: string;
  /** Do not expose application tools to this turn. */
  disableTools?: boolean;
  /** Omit earlier conversation turns while keeping the new user message. */
  includeConversationHistory?: boolean;
}

function estimateModelSizeB(modelId: string): number {
  const match = modelId.match(/-([\d.]+)[bB]/);
  return match ? parseFloat(match[1]) : 0;
}

interface UseChatStreamingOptions {
  disabled?: boolean;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Optional note context to prepend to the system prompt (used by embedded note chat). */
  noteContext?: string;
  noteId?: number;
  /** Optional container scope applied to the search_notes tool (container overview chat). */
  searchScope?: ContainerScope;
  onStreamComplete?: (assistantId: string, content: string, toolCalls?: ToolCallInfo[]) => void;
  /** bb's generated title for the thread that answered the latest turn. */
  onThreadTitle?: (title: string) => void;
}

export interface ChatStreaming {
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  sendToAI: (userText: string, allMessages: Message[], options?: ChatSendOptions) => Promise<void>;
  cancelStream: () => void;
}

type HistoryMessage = { role: string; content: string };

export function useChatStreaming({
  disabled = false,
  messages,
  setMessages,
  noteContext: externalNoteContext,
  noteId,
  searchScope,
  onStreamComplete,
  onThreadTitle,
}: UseChatStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const mountedRef = useRef(true);
  const messagesRef = useRef<Message[]>([]);
  const noteContextRef = useRef(externalNoteContext);
  noteContextRef.current = externalNoteContext;
  const searchScopeRef = useRef(searchScope);
  searchScopeRef.current = searchScope;
  const toolRegistryRef = useRef<{ key: string; registry: ToolRegistry } | null>(null);
  const toolActivityStartedAtRef = useRef<number | null>(null);
  const toolActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToolActivityTimer = useCallback(() => {
    if (toolActivityTimerRef.current) {
      clearTimeout(toolActivityTimerRef.current);
      toolActivityTimerRef.current = null;
    }
  }, []);

  const clearToolActivity = useCallback(() => {
    clearToolActivityTimer();
    toolActivityStartedAtRef.current = null;
    if (!mountedRef.current) return;
    setToolStatus("");
    setActiveToolName("");
  }, [clearToolActivityTimer]);

  const beginToolActivity = useCallback(
    (name: string, status: string) => {
      clearToolActivityTimer();
      toolActivityStartedAtRef.current = Date.now();
      setActiveToolName(name);
      setToolStatus(status);
    },
    [clearToolActivityTimer]
  );

  const completeToolActivity = useCallback(() => {
    const startedAt = toolActivityStartedAtRef.current;
    if (startedAt == null) {
      clearToolActivity();
      return;
    }

    const remainingMs = getAgentToolActivityRemainingMs(startedAt);
    clearToolActivityTimer();
    if (remainingMs === 0) {
      clearToolActivity();
      return;
    }

    toolActivityTimerRef.current = setTimeout(clearToolActivity, remainingMs);
  }, [clearToolActivity, clearToolActivityTimer]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendGenerationRef = useRef(0);
  // Generation stamped by the most recent cancel issued while still mounted
  // (Esc, a Stop button). The unmount cleanup below flips mountedRef off
  // before routing through cancelStream, so it never stamps this — which is
  // how sendToAI tells a user's cancel from an unmount mid-stream.
  const explicitCancelGenerationRef = useRef(0);
  const cancelStream = useCallback(() => {
    if (disabled) return;
    sendGenerationRef.current += 1;
    if (mountedRef.current) {
      explicitCancelGenerationRef.current = sendGenerationRef.current;
    }
    ReasoningService.cancelActiveStream();
    setAgentState("idle");
    clearToolActivity();
  }, [clearToolActivity, disabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Route through cancelStream so every cancellation path — Esc/Stop and
      // an unmount mid-stream alike — bumps the same generation counter.
      // Calling ReasoningService.cancelActiveStream() directly here (as this
      // used to) left sendToAI's cancelled() check unaware of an unmount
      // cancel, so its empty-response fallback still fired and persisted a
      // fabricated reply for a send the user never saw complete.
      cancelStream();
    };
  }, [cancelStream]);

  const sendToAI = useCallback(
    async (userText: string, allMessages: Message[], sendOptions?: ChatSendOptions) => {
      const sendGeneration = ++sendGenerationRef.current;
      const cancelled = () => sendGeneration !== sendGenerationRef.current;
      clearToolActivity();
      let responseAnnounced = false;
      const announceResponse = () => {
        if (responseAnnounced) return;
        responseAnnounced = true;
      };
      const settings = getSettings();
      const llmConfig = selectResolvedLLMConfig(settings, "chatIntelligence");
      const isBbAgent = llmConfig.mode === "agent";
      setAgentState("thinking");
      const isLanAgent = llmConfig.mode === "self-hosted" && !!llmConfig.remoteUrl;
      const isCustomAgent = llmConfig.mode === "providers" && llmConfig.provider === "custom";
      const isLocalProvider =
        !isBbAgent &&
        !isEnterpriseProvider(llmConfig.provider) &&
        ![
          "openai",
          "groq",
          "custom",
          "anthropic",
          "gemini",
          "tinfoil",
          "openrouter",
          "corti",
        ].includes(llmConfig.provider);
      const localModelCanUseTool =
        isLocalProvider && estimateModelSizeB(llmConfig.model) >= LOCAL_TOOL_MIN_PARAMS_B;
      const supportsTools = !sendOptions?.disableTools && !isBbAgent && (!isLocalProvider || localModelCanUseTool);

      const scope = searchScopeRef.current;
      let registry: ToolRegistry | null = null;
      if (supportsTools) {
        const scopeKey = scope ? `${scope.spaceId}:${scope.folderId ?? ""}` : "";
        // The calendar tool reads the shared provider-deduped events table,
        // so any connected provider enables it.
        const calendarConnected =
          settings.gcalConnected || settings.mcalConnected || settings.appleCalendarConnected;
        // Triggers ride in the tool description, so a snippet edit rebuilds the registry.
        const snippetKey = settings.snippets.map((s) => s.trigger).join("|");
        const cacheKey = `${calendarConnected}-${scopeKey}-${snippetKey}`;
        if (toolRegistryRef.current?.key === cacheKey) {
          registry = toolRegistryRef.current.registry;
        } else {
          registry = createToolRegistry({
            calendarConnected,
            searchScope: scope,
            vocabulary: {
              getDictionary: () => getSettings().customDictionary,
              updateDictionary: (changes) =>
                useSettingsStore.getState().updateCustomDictionary(changes),
              getSnippets: () => getSettings().snippets,
              setSnippets: (snippets) => useSettingsStore.getState().setSnippets(snippets),
            },
          });
          toolRegistryRef.current = { key: cacheKey, registry };
        }
      }

      if (cancelled() || !mountedRef.current) return;
      const combinedContext = isBbAgent && noteId
        ? `Current Note ID: ${noteId}. Use the Gristmill read-only CLI when exact Note content or transcript evidence is needed.`
        : noteContextRef.current;
      // The user's dictionary rides on every conversation so replies use their jargon.
      let systemPrompt = sendOptions?.systemPrompt ?? appendDictionarySuffix(
        getAgentSystemPrompt(
          registry?.getAll().map((t) => t.name),
          combinedContext || undefined
        ),
        getDictionaryHintWords(settings),
        settings.uiLanguage
      );

      const messagesForTurn = sendOptions?.includeConversationHistory === false
        ? allMessages.slice(-1)
        : allMessages;
      const history: HistoryMessage[] = messagesForTurn
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      const llmMessages = [{ role: "system", content: systemPrompt }, ...history];

      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", isStreaming: true },
      ]);
      setAgentState("streaming");

      try {
        let fullContent = "";
        let stream: AsyncGenerator<AgentStreamChunk>;

        // A disabled or never-chosen harness resolves empty; say so instead of spawning.
        if (isBbAgent && (!llmConfig.agentProvider || !llmConfig.agentModel)) {
          throw new Error(t("bbAgent.noSelection"));
        }
        const aiTools = registry?.toAISDKFormat();
        stream = ReasoningService.processTextStreamingAI(
          llmMessages,
          isBbAgent ? llmConfig.agentModel || "" : llmConfig.model,
          isBbAgent ? "bb" : llmConfig.provider,
          {
            systemPrompt,
            inferenceScope: llmConfig.scope,
            ...(isBbAgent ? {
              agentSelection: {
                provider: llmConfig.agentProvider || "",
                model: llmConfig.agentModel || "",
                reasoningLevel: llmConfig.agentReasoningLevel || "",
              },
              onThreadTitle,
            } : {}),
            lanUrl: isLanAgent ? llmConfig.remoteUrl : undefined,
            baseUrl: isCustomAgent ? llmConfig.cloudBaseUrl || undefined : undefined,
            customApiKey:
              isCustomAgent || isLanAgent ? llmConfig.customApiKey || undefined : undefined,
            disableThinking: llmConfig.disableThinking,
          },
          aiTools
        );

        for await (const chunk of stream) {
          if (!mountedRef.current) {
            ReasoningService.cancelActiveStream();
            break;
          }
          if (chunk.type === "content") {
            if (chunk.text) announceResponse();
            fullContent += chunk.text;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          } else if (chunk.type === "tool_calls") {
            if (chunk.calls.length > 0) announceResponse();
            for (const call of chunk.calls) {
              setAgentState("tool-executing");
              beginToolActivity(
                call.name,
                t(`agentMode.tools.${call.name}Status`, { defaultValue: `Using ${call.name}...` })
              );
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls || []),
                          {
                            id: call.id,
                            name: call.name,
                            arguments: call.arguments,
                            status: "executing" as const,
                          },
                        ],
                      }
                    : m
                )
              );
            }
          } else if (chunk.type === "tool_result") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId && m.toolCalls
                  ? {
                      ...m,
                      toolCalls: m.toolCalls.map((tc) =>
                        tc.id === chunk.callId
                          ? {
                              ...tc,
                              status: "completed" as const,
                              result: chunk.displayText,
                              ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
                            }
                          : tc
                      ),
                    }
                  : m
              )
            );
            setAgentState("streaming");
            completeToolActivity();
          }
        }

        if (cancelled() || !mountedRef.current) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? { ...message, isStreaming: false } : message
            )
          );
          // An unmount mid-stream (page navigation) keeps the partial reply in
          // history so the saved conversation matches what the user last saw;
          // an explicit cancel drops it. The unmount cleanup cancels too, so
          // cancelled() alone cannot tell the two apart.
          const explicitlyCancelled = explicitCancelGenerationRef.current > sendGeneration;
          if (!explicitlyCancelled && fullContent.trim().length > 0) {
            const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
            onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
          }
          return;
        }

        if (!responseAnnounced && !cancelled()) {
          // The stream ended without a visible token or tool call (think-only
          // local model, empty completion). Show that as a reply so the chat
          // always reaches a terminal outcome.
          fullContent = t("agentMode.chat.emptyResponse");
          announceResponse();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
          );
        }

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
        );

        const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
        onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
      } catch (error) {
        if (cancelled()) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? { ...message, isStreaming: false } : message
            )
          );
        } else {
          announceResponse();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: `${t("agentMode.chat.errorPrefix")}: ${(error as Error).message}`,
                    isStreaming: false,
                  }
                : m
            )
          );
        }
      }

      setAgentState("idle");
      completeToolActivity();
    },
    [
      t,
      setMessages,
      onStreamComplete,
      onThreadTitle,
      noteId,
      clearToolActivity,
      beginToolActivity,
      completeToolActivity,
    ]
  );

  return {
    agentState,
    toolStatus,
    activeToolName,
    sendToAI,
    cancelStream,
  };
}
