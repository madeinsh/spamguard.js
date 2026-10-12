# spamguard.js

Protect email addresses and phone numbers from spam bots and scrapers. No dependencies, ~1 KB gzipped.

-   The value is split into salted `data-*` attributes, so no `name@domain.tld` pattern appears in your HTML.
-   After initialization these attributes are removed. The value is rendered character by character as hex-escaped CSS pseudo-elements, in random order, inside a constructed stylesheet. It never appears as text in the DOM, `innerText` or a `<style>` tag.
-   Links (`mailto:`, `tel:`, …) are only built on click.

[Demo](https://madeinsh.github.io/spamguard.js/example/index.html)

## Installation

```bash
npm install spamguard.js
```

Or via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/spamguard.js@5/dist/spamguard.js"></script>
```

## Usage

```html
<a href="#" class="protect" data-name="mark" data-domain="gmail" data-tld="com" data-mailto></a>
```

`spamguard()` accepts a selector, an element, a NodeList, an array or a jQuery object.

```js
// Script tag (global)
spamguard('.protect')

// ES module
import spamguard from 'spamguard.js'
spamguard('.protect')

// CommonJS
const spamguard = require('spamguard.js')
spamguard('.protect')

// jQuery (load spamguard.js after jQuery)
$('.protect').spamguard()
```

Calling it again on the same elements is safe; already protected elements are skipped.

## Attributes

| Attribute       | Description                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ |
| `data-name`     | Everything before the `@` of the email address                                             |
| `data-domain`   | Domain name without extension                                                              |
| `data-tld`      | Extension without `.`                                                                      |
| `data-number`   | Phone number                                                                               |
| `data-text`     | Any other text                                                                             |
| `data-salt`     | Characters that are removed from the values above, so you can mix them in for confusion    |
| `data-mailto`   | Makes the element clickable (`mailto:`, `tel:`, …)                                         |
| `data-protocol` | Protocol for `data-number`: `tel` (default), `sms`, `whatsapp` or any other URI scheme     |
| `data-subject`  | Subject for `mailto:` links                                                                |
| `data-message`  | Body for `mailto:` links, text for WhatsApp links                                          |
| `data-content`  | Keeps your own content (e.g. an icon) instead of rendering the value                       |

Boolean attributes (`data-mailto`, `data-content`) are enabled when present, unless set to `"false"`.

## Examples

```html
<!-- Email with salt: renders mark@gmail.com -->
<a href="#" class="protect" data-name="_mZ1a4.rk9" data-domain="g%m$$a@il" data-tld="c§Xo7m.Y" data-salt="XYZ_.§$%&@Z0123456789" data-mailto></a>

<!-- Own content with subject and message -->
<a href="#" class="protect" data-name="mark" data-domain="gmail" data-tld="com" data-mailto data-content data-subject="Contact" data-message="Hello!">
    <i class="icon-mail"></i>
</a>

<!-- Phone number: renders +1 808 555 0123 -->
<a href="#" class="protect" data-number="_+1 $&80=8 :555;; 01-))23" data-salt="§$%&/()=_:;.-[]" data-mailto></a>

<!-- WhatsApp -->
<a href="#" class="protect" data-number="+1 808 555 0123" data-protocol="whatsapp" data-message="Hi there!" data-mailto></a>

<!-- Any text: renders Hello World! -->
<span class="protect" data-text="H$e__l-[l].o ::W=o)r%&%ld.!" data-salt="§$%&/()=_:;.-[]"></span>
```

Use `<a href="#">` or `<button>` for clickable elements so they work with the keyboard. Rendered values inherit the surrounding styles, so you can use `text-align` etc. as usual. Note that rendered values cannot be selected or copied.

## Browser support

All current browsers (requires [constructable stylesheets](https://caniuse.com/mdn-api_document_adoptedstylesheets): Chrome 73+, Firefox 101+, Safari 16.4+).

## Upgrading from 4.x

-   `data-align-content` was removed. Values are now rendered inline, so use CSS (`text-align`) instead.
-   `data-mailto` and `data-content` no longer need a value: `data-mailto` is enough.
-   The `data-spamguard` marker attribute is gone, and the source attributes (`data-name`, `data-number`, `data-salt`, …) are removed after initialization.

## Development

```bash
npm install
npm run lint
npm run build
```
