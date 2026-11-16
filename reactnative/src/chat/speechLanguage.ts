import Fuse from "fuse.js/basic";
import langs from "langs";

export type SpeechLanguage = string;
export type SpeechSelection = { language?: SpeechLanguage; voice?: string };
export type SpeechLanguageOption = {
  code: string;
  label: string;
  englishName: string;
  nativeName: string;
};

function languageTag(value: string): string | undefined {
  const tag = value.trim().replaceAll("_", "-");
  if (!tag) return;
  if (typeof Intl.getCanonicalLocales !== "function") {
    if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(tag)) return;
    return tag
      .split("-")
      .map((part, index) =>
        index === 0
          ? part.toLowerCase()
          : part.length === 2
            ? part.toUpperCase()
            : part,
      )
      .join("-");
  }
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return;
  }
}
function displayName(code: string, locale?: string): string | undefined {
  try {
    if (typeof Intl.DisplayNames === "function") {
      const name = new Intl.DisplayNames(locale ? [locale] : undefined, {
        type: "language",
        fallback: "none",
      }).of(code);
      if (name) return name;
    }
  } catch {
    /* Some native runtimes cannot provide display names. */
  }
}
function languageNames(code: string) {
  const base = code.split("-")[0];
  const fallback = langs.where(base.length === 2 ? "1" : "3", base);
  return {
    englishName: displayName(code, "en") ?? fallback?.name ?? code,
    nativeName: displayName(code, base) ?? fallback?.local ?? code,
  };
}
export function speechLanguageLabel(code: string): string {
  return displayName(code) ?? languageNames(code).englishName;
}
export function availableSpeechLanguages(
  voices: { language: string }[],
): SpeechLanguageOption[] {
  const codes = new Set(
    voices
      .map((voice) => languageTag(voice.language))
      .filter((code): code is string => Boolean(code)),
  );
  return [...codes]
    .map((code) => ({
      code,
      label: speechLanguageLabel(code),
      ...languageNames(code),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
// Build once per voice-catalog update, rather than on each keystroke.
export function createSpeechLanguageSearch(options: SpeechLanguageOption[]) {
  const index = new Fuse(options, {
    keys: ["code", "label", "englishName", "nativeName"],
    threshold: 0.35,
    ignoreLocation: true,
    ignoreDiacritics: true,
  });
  return (query: string): SpeechLanguageOption[] => {
    const text = query.trim().replaceAll("_", "-");
    return text ? index.search(text).map(({ item }) => item) : options;
  };
}
export function voiceForLanguage<
  T extends { language: string; identifier: string },
>(language: SpeechLanguage, voices: T[]): T | undefined {
  const requested = languageTag(language)?.toLowerCase();
  if (!requested) return;
  const exact = voices.find(
    (voice) => languageTag(voice.language)?.toLowerCase() === requested,
  );
  if (exact || requested.includes("-")) return exact;
  return voices.find(
    (voice) => languageTag(voice.language)?.split("-")[0] === requested,
  );
}
