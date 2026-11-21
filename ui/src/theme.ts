import { createColorScheme, createLocalStorage } from "@ui-sdk/core"

// Light, dark, or the browser's choice. Preferences puts the choice on
// <html data-color-scheme>, and index.css maps it to color-scheme, which
// drives the light-dark() colors in web.css.
export const colorScheme = createColorScheme({
  global: true,
  storage: createLocalStorage("micros3-color-scheme"),
})
