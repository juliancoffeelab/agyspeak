import { createContext, use, type ReactNode } from "react";
import type { OpenRouterConnection } from "../../connections/openrouter";
import type { PreferencesOwner } from "../../preferences/preferences";

// What Settings may reach: the connection it edits and the default
// preferences.
export type SettingsScope = {
  connection: OpenRouterConnection;
  preferences: PreferencesOwner;
};

const SettingsScopeContext = createContext<SettingsScope | null>(null);

export function SettingsScopeProvider({
  scope,
  children,
}: {
  scope: SettingsScope | null;
  children: ReactNode;
}) {
  return <SettingsScopeContext value={scope}>{children}</SettingsScopeContext>;
}

// Null until the settings are open.
export function useSettingsScope() {
  return use(SettingsScopeContext);
}
