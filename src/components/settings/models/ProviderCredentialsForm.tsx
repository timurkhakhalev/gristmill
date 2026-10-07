import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../../stores/settingsStore";
import ApiKeyInput from "../../ui/ApiKeyInput";
import { Input } from "../../ui/input";
import { SelectField } from "../../ui/SelectField";
import { GetApiKeyLink } from "../../ui/GetApiKeyLink";
import {
  credentialSetterName,
  type CredentialKey,
  type CredentialSaveResult,
  type CredentialSetter,
  type ProviderCapability,
  type ProviderEntry,
} from "./providerDirectory";
import { useCredentialValues } from "./useCredentialValues";

/** Credential fields of one provider, optionally limited to the fields a task needs. */
export function ProviderCredentialsForm({
  entry,
  capability,
}: {
  entry: ProviderEntry;
  capability?: ProviderCapability;
}) {
  const { t } = useTranslation();
  const values = useCredentialValues();

  const fields = capability
    ? entry.fields.filter(
        (field) =>
          field.capability === capability ||
          !entry.fields.some((item) => item.capability === capability)
      )
    : entry.fields;

  const setValue = (
    key: CredentialKey,
    value: string
  ): CredentialSaveResult | Promise<CredentialSaveResult> => {
    // SAFETY: credentialSetterName maps each CredentialKey to the store's matching
    // setter; secret setters resolve a save result, plain setters resolve void.
    const setter = useSettingsStore.getState()[credentialSetterName(key)] as CredentialSetter;

    return setter(value);
  };

  return (
    <div className="space-y-3">
      {entry.noteKey && (!capability || capability === "language") && (
        <p className="text-xs text-muted-foreground">{t(entry.noteKey)}</p>
      )}
      {fields.map((field, index) => {
        const label = field.labelKey ? t(field.labelKey) : t("common.apiKey");

        return (
          <div key={field.key} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label className="text-xs font-medium text-foreground">{label}</label>
              {index === 0 && <GetApiKeyLink url={entry.consoleUrl} />}
            </div>
            {field.input === "secret" ? (
              <ApiKeyInput
                apiKey={values[field.key]}
                setApiKey={(value) => setValue(field.key, value)}
                label=""
                ariaLabel={`${entry.name} ${label}`}
                helpText=""
              />
            ) : field.input === "select" ? (
              <SelectField
                value={values[field.key]}
                onChange={(value) => {
                  Promise.resolve(setValue(field.key, value)).catch(() => {});
                }}
                options={(field.options ?? []).map((option) => ({
                  id: option.value,
                  label: option.label,
                }))}
                ariaLabel={label}
                size="sm"
                className="w-full"
              />
            ) : (
              <Input
                dir="ltr"
                value={values[field.key]}
                onChange={(event) => {
                  Promise.resolve(setValue(field.key, event.target.value)).catch(() => {});
                }}
                placeholder={field.placeholder}
                aria-label={label}
                className="h-8 text-sm"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
