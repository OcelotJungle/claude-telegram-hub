import type { Language } from "./protocol.ts";

// The forms of a counted noun by plural category (CLDR); `other` is required and
// stands in for any category the language has but the caller left out.
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

// The category comes from Intl.PluralRules for the language, so no grammar is
// coded by hand: en has one/other, ru has one/few/many/other.
export function plural(language: Language, n: number, forms: PluralForms): string {
  return forms[new Intl.PluralRules(language).select(n)] ?? forms.other;
}
