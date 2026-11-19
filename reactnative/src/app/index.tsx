import { StartupStatus } from "../application/AppScope";
import { ChatEntry } from "../features/chat/ChatEntry";

export default function ChatRoute() {
  return <ChatEntry status={<StartupStatus />} />;
}
