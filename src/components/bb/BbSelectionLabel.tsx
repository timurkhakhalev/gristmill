import { useTranslation } from "react-i18next";
import { HarnessIcon } from "./HarnessIcon";
import { useBbModels } from "./useBbCatalog";
import type { BbHarness } from "../../contracts/bb";

/** Harness icon, model name and reasoning label, as shown on picker triggers. */
export function BbSelectionLabel({ harness, model, reasoningLevel, hideIcon = false }: { harness: BbHarness | undefined; model: string; reasoningLevel: string; hideIcon?: boolean }) {
  const { t } = useTranslation();
  const { models } = useBbModels(harness?.id ?? "");
  if (!harness || !model) return <span className="truncate">{t("bbAgent.chooseModel")}</span>;
  const modelName = models.find((item) => item.id === model)?.displayName ?? model;
  const level = harness.reasoningLevels?.find((item) => item.id === reasoningLevel)?.label ?? reasoningLevel;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {!hideIcon && <HarnessIcon logo={harness.logo} className="size-3.5" />}
      <span className="truncate">{modelName}</span>
      {level && <span className="shrink-0 text-muted">{level}</span>}
    </span>
  );
}
