// Every language has every key, and keeps every {placeholder} of the English
// text: a missing one falls back to English, a lost {time} shows a broken line.
import { describe, it, expect } from 'vitest'
import { DICTS } from './i18n'

const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('translations', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    if (lang === 'en') continue
    it(`${lang} has every key with the same placeholders`, () => {
      for (const [key, text] of Object.entries(DICTS.en)) {
        expect(dict[key], `${lang} ${key}`).toBeTypeOf('string')
        expect(holes(dict[key]), `${lang} ${key}`).toEqual(holes(text))
      }
    })
  }
})
