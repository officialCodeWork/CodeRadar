import { useTranslation } from "react-i18next";

export function TeamHeader() {
  const { t } = useTranslation();

  return (
    <header>
      <h1>{t("team.title")}</h1>
      <button>{t("team.invite")}</button>
    </header>
  );
}
