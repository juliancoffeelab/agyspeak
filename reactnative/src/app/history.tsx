import { StartupStatus } from "../application/AppScope";
import { HistoryScreen } from "../features/chat/HistoryScreen";

export default function HistoryRoute() {
  return <HistoryScreen status={<StartupStatus />} />;
}
