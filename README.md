# spamguard.js

Protect email addresses and phone numbers from spam bots, scrapers and AI crawlers. No dependencies, ~2.3 KB gzipped.

- The value is encoded into a single `data-spamguard` attribute: no recognizable pattern, and every encoding looks different.
- spamguard.js decodes it in the browser, draws it on a `<canvas>` and removes the attribute. From then on the value only exists as pixels: it's not in the HTML, the DOM, `innerText`, any stylesheet, `getComputedStyle()` or the accessibility tree.
- Characters are created, measured and drawn one by one in random order, so bots hooking browser functions (`fillText()`, `String.fromCodePoint()`, …) only see an anagram.
- Links are decoded on a real click only. Clicks triggered by scripts (`el.click()`) are ignored, and `javascript:`, `vbscript:` and `data:` links are never opened.
- With `data-reveal`, nothing is drawn until someone clicks, so even screenshot bots get nothing.

[Demo & generator](https://madeinsh.github.io/spamguard.js/example/index.html)

## What it protects against

| Attacker                                                                                       | Protected                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Harvesters scanning the HTML source                                                            | ✅                                        |
| Generic decoders (Base64, ROT13, HTML entities, …)                                             | ✅                                        |
| Headless browsers reading the DOM, `innerText`, CSS or the accessibility tree (e.g. AI agents) | ✅                                        |
| Headless browsers hooking string and canvas functions                                          | ✅                                        |
| Scripts calling `el.click()` or `dispatchEvent()`                                              | ✅                                        |
| Automated browsers that really click (Playwright, Puppeteer, AI agents)                        | ❌ Link and `data-reveal` value on click  |
| Screenshots with OCR or vision models                                                          | ⚠️ Only with `data-reveal`, until a click |
| A scraper written specifically for spamguard.js                                                | ❌                                        |

No client-side script can stop a scraper built specifically against it: the decoder is public and runs in every visitor's browser. If that matters to you, don't put the value in the page at all (e.g. use a contact form).

## Installation

```bash
npm install spamguard.js
```

Or via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/spamguard.js@27/dist/spamguard.js"></script>
```

## Usage

1. Encode the value with the [generator](https://madeinsh.github.io/spamguard.js/example/index.html) or `spamguard.encode()` (see below).
2. Put it into your HTML:

```html
<a href="#" data-spamguard="zN4CvIgLQ+6HZgRhe8DYO52YT9HdA/BsdyyNnwiGUexv3ItrDJiYGj4=" aria-label="Send email"></a>
```

3. Call `spamguard()`:

```js
// Script tag (global)
spamguard()

// ES module
import spamguard from 'spamguard.js'
spamguard()

// CommonJS
const spamguard = require('spamguard.js')
spamguard()

// jQuery (load spamguard.js after jQuery)
$('[data-spamguard]').spamguard()
```

Without an argument, all `[data-spamguard]` elements are protected. You can also pass a selector, an element, a NodeList, an array or a jQuery object. Calling it again is safe; already protected elements are skipped. Elements must be in the document.

## Encoding

`spamguard.encode(text, href)` takes the text to display and the link to open on click. Both are optional. Use it at build time or on the server, never in the page that shows the value.

```js
const { encode } = require('spamguard.js')

encode('mark@gmail.com', 'mailto:mark@gmail.com?subject=Hello')
encode('+1 808 555 0123', 'tel:+18085550123')
encode('+1 808 555 0123', 'sms:+18085550123')
encode('+1 808 555 0123', 'https://wa.me/18085550123?text=Hi%20there!')
encode('Hello World!') // Text only, no link
encode('', 'mailto:mark@gmail.com') // Link only, for data-content
```

## Attributes

| Attribute        | Description                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-spamguard` | The encoded value                                                                                                                            |
| `data-reveal`    | Shows your own content (e.g. "Show phone number") until the element is clicked, then the value. If there is a link, the next click opens it. |
| `data-content`   | Keeps your own content (e.g. an icon) instead of rendering the value. The link still works on click.                                         |

Boolean attributes are enabled when present, unless set to `"false"`.

## Examples

```html
<!-- Email -->
<a href="#" data-spamguard="…" aria-label="Send email"></a>

<!-- Own content -->
<a href="#" data-spamguard="…" data-content>✉️ Write me</a>

<!-- Shown after a click -->
<a href="#" data-spamguard="…" data-reveal>Show phone number</a>

<!-- Text without link -->
<span data-spamguard="…"></span>
```

## Accessibility and styling

Screen readers can't read a canvas, which is the point. Give links an `aria-label` without the value, e.g. `aria-label="Send email"`: activating the link opens the mail app with the address. With `data-reveal`, the placeholder text (e.g. "Show phone number") is kept as `aria-label`, unless the element has one. Use `<a href="#">` or `<button>` for clickable elements so they work with the keyboard.

The rendered value inherits font style, weight, size and family, color, letter spacing, `text-transform` (uppercase and lowercase) and underline (drawn as a solid line), and follows changes (hover, dark mode, responsive font sizes, zoom; see [Browser support](#browser-support)). It doesn't wrap, scales down to fit its container, and can't be selected, copied or found with the browser's search. Other text effects (`text-shadow`, font features, overline, line-through, …) aren't applied.

## Browser support

All current browsers: Chrome 87+, Firefox 116+, Safari 14.1+. Some redraws need newer versions, older ones keep the previous rendering until the next redraw:

- Changes of only the font family, underline or `text-transform` (e.g. an underline on hover): Chrome 117+, Firefox 129+, Safari 17.4+. Changes of color and size are followed in all versions above.
- Zoom changes: Safari 16+.

## Upgrading from earlier versions

- The attributes `data-name`, `data-domain`, `data-tld`, `data-number`, `data-text`, `data-salt`, `data-mailto`, `data-protocol`, `data-subject` and `data-message` were replaced by `data-spamguard`. Re-create your values with the generator or `spamguard.encode()`. The old format put everything a scraper needs right into the HTML (the salt sits next to the value), and the rendered CSS pseudo-elements could be read with `getComputedStyle()` and from the accessibility tree.
- `spamguard()` without an argument protects all `[data-spamguard]` elements.
- Links no longer open on clicks triggered by scripts.
- Add an `aria-label` to links (see above).

## Development

```bash
npm install
npm run lint
npm test
npm run build
```
