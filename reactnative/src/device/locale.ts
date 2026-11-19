// The device's language as a base code such as "uk", or null when the runtime
// cannot tell. A base code matches any regional voice of that language.
// Hermes has no `Intl.Locale`; the resolved tag's first subtag is the language.
export function systemLanguage(): string | null {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    const base = tag.split(/[-_]/)[0].toLowerCase();
    return /^[a-z]{2,3}$/.test(base) ? base : null;
  } catch {
    return null;
  }
}
