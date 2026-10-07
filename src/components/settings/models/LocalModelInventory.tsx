import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../ui/dialog";
import { useDialogs } from "../../../hooks/useDialogs";
import { LOCAL_MODELS_CHANGED_EVENT, useModelDownload } from "../../../hooks/useModelDownload";
import {
  modelRegistry,
  PARAKEET_MODEL_INFO,
  WHISPER_MODEL_INFO,
} from "../../../models/ModelRegistry";
import {
  getASRModelOrganization,
  usesParakeetManager,
} from "../../../helpers/localASROrganization";
import logger from "../../../utils/logger";
import type { ParakeetCheckResult } from "../../../types/electron";
import {
  InventoryContext,
  type LocalModelEntry,
  type LocalModelInventory,
  type LocalModelKind,
} from "./inventoryContext";

type DownloadedSets = Record<LocalModelKind, Set<string>>;

async function readDownloaded(): Promise<DownloadedSets> {
  const [whisper, parakeet, llm] = await Promise.all([
    window.electronAPI?.listWhisperModels?.().catch(() => null),
    window.electronAPI?.listParakeetModels?.().catch(() => null),
    window.electronAPI?.modelGetAll?.().catch(() => null),
  ]);

  const fromList = (
    result:
      | { success: boolean; models: Array<{ model: string; downloaded?: boolean }> }
      | null
      | undefined
  ) =>
    new Set(
      result?.success
        ? result.models.filter((item) => item.downloaded).map((item) => item.model)
        : []
    );

  return {
    whisper: fromList(whisper),
    parakeet: fromList(parakeet),
    llm: new Set((llm ?? []).filter((item) => item.isDownloaded).map((item) => item.id)),
  };
}

/**
 * One inventory for the whole Models page, so the task pickers and the local
 * model manager share download state and show one error per failed download.
 */
export function LocalModelInventoryProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  const [downloaded, setDownloaded] = useState<DownloadedSets>({
    whisper: new Set(),
    parakeet: new Set(),
    llm: new Set(),
  });

  const [capability, setCapability] = useState<ParakeetCheckResult | null>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const reload = useCallback(async () => {
    try {
      setDownloaded(await readDownloaded());
    } catch (error) {
      logger.error("Failed to load local models", { error }, "models");
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
    window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((value) => setCapability(value))
      .catch((cause: unknown) =>
        logger.error("Failed to check Parakeet compatibility", { error: cause }, "models")
      );

    const onModelsChanged = () => {
      reload().catch(() => {});
    };

    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, onModelsChanged);

    return () => window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, onModelsChanged);
  }, [reload]);

  const whisper = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: () => {
      reload().catch(() => {});
    },
    onModelsCleared: () => {
      reload().catch(() => {});
    },
  });

  const parakeet = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: () => {
      reload().catch(() => {});
    },
    onModelsCleared: () => {
      reload().catch(() => {});
    },
  });

  const llm = useModelDownload({
    modelType: "llm",
    onDownloadComplete: () => {
      reload().catch(() => {});
    },
    onModelsCleared: () => {
      reload().catch(() => {});
    },
  });

  const managers = useMemo(() => ({ whisper, parakeet, llm }), [whisper, parakeet, llm]);

  const sherpaSupported = capability?.supported !== false;

  const sherpaReason = capability?.minimumMacOSVersion
    ? t("transcription.parakeet.requiresMacOS", { version: capability.minimumMacOSVersion })
    : t("transcription.parakeet.unavailable");

  const speech = useMemo<LocalModelEntry[]>(
    () => [
      ...Object.entries(PARAKEET_MODEL_INFO).map(([id, info]) => {
        const organization = getASRModelOrganization(id);

        return {
          id,
          kind: "parakeet" as const,
          organization,
          name: info.name,
          size: info.size,
          recommended: !!info.recommended,
          downloaded: downloaded.parakeet.has(id),
          modelCardUrl: info.modelCardUrl,
          unavailableReason:
            sherpaSupported || !usesParakeetManager(organization) ? undefined : sherpaReason,
        };
      }),
      ...Object.entries(WHISPER_MODEL_INFO).map(([id, info]) => ({
        id,
        kind: "whisper" as const,
        organization: "whisper",
        name: info.name,
        size: info.size,
        recommended: !!info.recommended,
        downloaded: downloaded.whisper.has(id),
      })),
    ],
    [downloaded, sherpaReason, sherpaSupported]
  );

  const language = useMemo<LocalModelEntry[]>(
    () =>
      modelRegistry.getAllProviders().flatMap((provider) =>
        provider.models.map((model) => ({
          id: model.id,
          kind: "llm" as const,
          organization: provider.id,
          name: model.name,
          size: model.size,
          recommended: !!model.recommended,
          downloaded: downloaded.llm.has(model.id),
          modelCardUrl: model.hfRepo ? `https://huggingface.co/${model.hfRepo}` : undefined,
        }))
      ),
    [downloaded]
  );

  const value = useMemo<LocalModelInventory>(
    () => ({
      speech,
      language,
      sherpaSupported,
      find: (kind, id) => (kind === "speech" ? speech : language).find((entry) => entry.id === id),
      downloadState: (entry) => {
        const manager = managers[entry.kind];
        const status = manager.downloads[entry.id];

        if (!status) return null;

        return {
          progress: status.progress,
          installing: status.phase === "installing",
          cancelling: manager.isCancellingModel(entry.id),
        };
      },
      download: (entry) => {
        managers[entry.kind].downloadModel(entry.id).catch(() => {});
      },
      cancel: (entry) => {
        managers[entry.kind].cancelDownload(entry.id).catch(() => {});
      },
      remove: (entry) =>
        showConfirmDialog({
          title: t("transcription.deleteModel.title"),
          description: t("transcription.deleteModel.description"),
          variant: "destructive",
          onConfirm: () => {
            managers[entry.kind]
              .deleteModel(entry.id, () => {
                reload().catch(() => {});
              })
              .catch(() => {});
          },
        }),
    }),
    [speech, language, sherpaSupported, managers, showConfirmDialog, reload, t]
  );

  return (
    <InventoryContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </InventoryContext.Provider>
  );
}
