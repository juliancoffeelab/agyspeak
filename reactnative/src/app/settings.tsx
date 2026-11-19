import { StartupStatus } from "../application/AppScope";
import { SettingsScreen } from "../features/settings/SettingsScreen";

export default function SettingsRoute() {
  return <SettingsScreen status={<StartupStatus />} />;
}
