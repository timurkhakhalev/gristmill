import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { Input } from "../ui/input";

export function ProfileNameField() {
  const { t } = useTranslation();
  const name = useSettingsStore((state) => state.profileName);
  const setName = useSettingsStore((state) => state.setProfileName);
  return (
    <div className="space-y-2">
      <label htmlFor="profile-name" className="text-sm font-medium">{t("profile.name")}</label>
      <Input dir="auto" id="profile-name" autoComplete="name" maxLength={200} value={name}
        onChange={(event) => setName(event.target.value)} placeholder={t("profile.placeholder")}
        aria-describedby="profile-name-help" />
      <p id="profile-name-help" className="text-sm text-muted-foreground">{t("profile.help")}</p>
    </div>
  );
}
