import { useTranslation } from "react-i18next";
import { ExternalLink } from "../icons";
import { createExternalLinkHandler, withUtm } from "../../utils/externalLinks";

export function GetApiKeyLink({
  url,
  labelKey = "reasoning.getApiKey",
  className = "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-link hover:underline underline-offset-2 cursor-pointer",
}: {
  url: string;
  labelKey?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const href = withUtm(url, "api_key");

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={createExternalLinkHandler(href)}
      className={className}
    >
      {t(labelKey)}
      <ExternalLink className="size-3 rtl:-scale-x-100" aria-hidden="true" />
    </a>
  );
}
