import { Globe, Download, Trash2, X, ExternalLink } from "../icons";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import type { ColorScheme } from "../../utils/modelPickerStyles";
import { createExternalLinkHandler, withUtm } from "../../utils/externalLinks";

export interface ModelCardOption {
  value: string;
  label: string;
  description?: string;
  specUrl?: string;
  icon?: string;
  invertInDark?: boolean;
  // Explicit group for SearchableModelList; falls back to the "provider/"
  // prefix of `value` when absent (e.g. Bedrock ids carry no slash).
  group?: string;
  // Local model properties (optional)
  isDownloaded?: boolean;
  isDownloading?: boolean;
  isCancelling?: boolean;
  recommended?: boolean;
}

interface ModelCardProps {
  model: ModelCardOption;
  isSelected: boolean;
  onSelect: (modelId: string) => void;
  colorScheme?: ColorScheme;
  // Kept for call-site compatibility; descriptions now render on a second row.
  truncateDescription?: boolean;
  // Local model actions (optional - when provided, enables local model UI)
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancelDownload?: (modelId: string) => void;
}

export function ModelCard({
  model,
  isSelected,
  onSelect,
  onDownload,
  onDelete,
  onCancelDownload,
}: ModelCardProps) {
  const { t } = useTranslation();
  const isLocalMode = Boolean(onDownload);
  const isDownloaded = model.isDownloaded;
  const isDownloading = model.isDownloading;
  const modelIsCancelling = model.isCancelling ?? false;
  const specHref = model.specUrl ? withUtm(model.specUrl, "model_spec") : undefined;

  const handleCardClick = () => {
    if (isLocalMode) {
      if (isDownloaded && !isSelected) {
        onSelect(model.value);
      }
    } else {
      onSelect(model.value);
    }
  };

  const isSelectable = !isLocalMode || Boolean(isDownloaded);

  return (
    <div
      role="radio"
      aria-checked={isSelected}
      aria-disabled={!isSelectable}
      tabIndex={isSelectable ? 0 : -1}
      onClick={handleCardClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleCardClick();
        }
      }}
      className={`group relative w-full min-h-[44px] overflow-hidden rounded-lg border px-3 py-2 text-start outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus ${
        isSelected
          ? "border-primary/60 bg-primary/8"
          : "border-border bg-surface hover:bg-surface-secondary"
      } ${isSelectable && !isSelected ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          aria-hidden="true"
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
            isSelected
              ? "border-accent bg-accent"
              : isDownloading
                ? "border-warning border-dashed animate-[spinner-rotate_1s_linear_infinite]"
                : isSelectable
                  ? "border-border-hover"
                  : "border-border border-dashed"
          }`}
        >
          {isSelected && <span className="size-1.5 rounded-full bg-accent-foreground" />}
        </span>

        {model.icon ? (
          <img
            src={model.icon}
            alt=""
            className={`w-3.5 h-3.5 shrink-0 ${model.invertInDark ? "icon-monochrome" : ""}`}
            aria-hidden="true"
          />
        ) : (
          <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}

        <span
          dir="ltr"
          className="text-sm font-semibold text-foreground tracking-tight truncate min-w-0 flex-1"
        >
          {model.label}
        </span>

        <div className="ms-auto flex items-center gap-1.5 shrink-0">
          {model.recommended && (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
              {t("common.recommended")}
            </span>
          )}
          {isLocalMode && (
            <>
              {isDownloaded ? (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(model.value);
                  }}
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-[color,opacity,transform] active:scale-95"
                >
                  <Trash2 size={12} />
                </Button>
              ) : isDownloading ? (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelDownload?.(model.value);
                  }}
                  disabled={modelIsCancelling}
                  size="sm"
                  variant="outline"
                  className="h-6 px-2.5 text-xs text-danger border-danger/25 hover:bg-danger/8"
                >
                  <X size={11} className="me-0.5" />
                  {modelIsCancelling ? "..." : t("common.cancel")}
                </Button>
              ) : (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload?.(model.value);
                  }}
                  size="sm"
                  variant="default"
                  className="h-6 px-2.5 text-xs"
                >
                  <Download size={11} className="me-1" />
                  {t("common.download")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {(model.description || specHref) && (
        <div className="mt-0.5 ps-[3.125rem] flex items-center gap-2 min-w-0">
          {model.description && (
            <span className="text-xs text-muted-foreground truncate min-w-0 flex-1">
              {model.description}
            </span>
          )}
          {specHref && (
            <a
              href={specHref}
              onClick={createExternalLinkHandler(specHref)}
              className="inline-flex items-center gap-0.5 text-xs text-primary/60 hover:text-primary transition-colors shrink-0"
            >
              {t("models.learnMore")}
              <ExternalLink size={9} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

interface ModelCardListProps {
  models: ModelCardOption[];
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  colorScheme?: ColorScheme;
  className?: string;
  truncateDescription?: boolean;
  // Local model actions (optional - when provided, enables local model UI)
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancelDownload?: (modelId: string) => void;
}

export default function ModelCardList({
  models,
  selectedModel,
  onModelSelect,
  colorScheme = "purple",
  className = "",
  truncateDescription = false,
  onDownload,
  onDelete,
  onCancelDownload,
}: ModelCardListProps) {
  const { t } = useTranslation();

  if (models.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">{t("models.noneAvailable")}</p>;
  }

  return (
    <div role="radiogroup" className={`space-y-1 ${className}`}>
      {models.map((model) => (
        <ModelCard
          key={model.value}
          model={model}
          isSelected={selectedModel === model.value}
          onSelect={onModelSelect}
          colorScheme={colorScheme}
          truncateDescription={truncateDescription}
          onDownload={onDownload}
          onDelete={onDelete}
          onCancelDownload={onCancelDownload}
        />
      ))}
    </div>
  );
}
