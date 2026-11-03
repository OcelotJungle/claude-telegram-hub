import type { Language } from "../protocol.ts";
import type { Messages } from "./en.ts";

import { LANGUAGES } from "../protocol.ts";
import { en } from "./en.ts";
import { ru } from "./ru.ts";

export type { Language } from "../protocol.ts";
export type { Messages } from "./en.ts";

export const DEFAULT_LANGUAGE: Language = "en";

export function catalogOf(language: Language): Messages {
  return language === "ru" ? ru : en;
}

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(language => language === value);
}
