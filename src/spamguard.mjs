/**
 * spamguard.js protects email addresses, phone numbers and texts from bots and scrapers.
 *
 * 1. spamguard.encode() turns the value into an opaque Base64 string for the data-spamguard attribute. It runs at build
 *    time or on the server, so the plain value never appears in the HTML.
 * 2. spamguard() decodes it in the browser, removes the attribute and draws the text on a <canvas>. From then on the
 *    value only exists as pixels: it's not in the DOM, in a stylesheet, in getComputedStyle() or in the accessibility
 *    tree.
 * 3. The link is decoded again on each real click. Clicks triggered by scripts are ignored.
 *
 * Bots can hook built-in functions (fillText(), String.fromCodePoint(), join(), …) to log their arguments. So the
 * plain value never passes through one of them as a whole string: characters are created, measured and drawn one by
 * one, in random order.
 */

/**
 * Styles of the canvas, set with !important so CSS resets (canvas { display: block }, reduced motion) can't break it.
 * The canvas flows inline like text. A change of the inherited styles below starts a tiny transition, whose end
 * triggers a redraw.
 */
const CANVAS_STYLE = {
    display: 'inline',
    'text-decoration': 'inherit',
    'transition-property': 'color, font, letter-spacing, line-height, text-decoration, text-underline-offset, text-transform',
    'transition-duration': '1ms',
    'transition-behavior': 'allow-discrete',
}

/** Events of the redraw transitions. They are swallowed, so they never reach the page's own listeners. */
const TRANSITION_EVENTS = ['transitionrun', 'transitionstart', 'transitioncancel', 'transitionend']

/** URL schemes that run code. Links with them are never opened. */
const SCRIPT_SCHEMES = ['javascript', 'vbscript', 'data']

/** Number of random bytes at the start of an encoded value. They seed the keystream. */
const SEED_LENGTH = 4

/** Highest valid Unicode code point */
const MAX_CODE_POINT = 0x10ffff

/** Code point of ":", which ends the scheme of a URL */
const COLON = 0x3a

/**
 * Off-screen canvas that each character is drawn on before it's copied into place. Shared by all elements and created
 * on first use.
 *
 * @type {HTMLCanvasElement | undefined}
 */
let scratch

/**
 * Protects email addresses, phone numbers and texts from bots and scrapers.
 *
 * Decodes the data-spamguard attribute of each element, removes it and renders the value. Elements that are already
 * protected, not in the document or have an invalid value are skipped, so calling it again is safe.
 *
 * @example
 * spamguard() // All [data-spamguard] elements
 * spamguard('footer [data-spamguard]')
 * spamguard(document.getElementById('email'))
 *
 * @param {string | Element | ArrayLike<Element>} [target='[data-spamguard]'] CSS selector, element, NodeList, array or
 * jQuery object
 * @returns {void}
 */
export default function spamguard(target = '[data-spamguard]') {
    const elements = typeof target === 'string' ? document.querySelectorAll(target) : target.nodeType ? [target] : target

    Array.from(elements).forEach(protect)
}

/**
 * Encodes a value for the data-spamguard attribute.
 *
 * Run it at build time, on the server or in the generator, never in the page that shows the value. Every call returns
 * a different result, so there is no fixed pattern a scraper could look for. The format is described at decode().
 *
 * @example
 * spamguard.encode('mark@gmail.com', 'mailto:mark@gmail.com?subject=Hello')
 * spamguard.encode('Hello World!') // Text only, no link
 * spamguard.encode('', 'tel:+18085550123') // Link only, for data-content
 *
 * @param {string} [text=''] Text to display, e.g. "mark@gmail.com"
 * @param {string} [href=''] Link to open on click, e.g. "mailto:mark@gmail.com"
 * @returns {string} Value for the data-spamguard attribute
 */
spamguard.encode = function encode(text = '', href = '') {
    const codePoints = [...href, ...text.normalize('NFC')].map((char) => char.codePointAt(0))
    const plain = [[...href].length, ...codePoints].flatMap(varint)
    const seed = Array.from({ length: SEED_LENGTH }, () => Math.floor(Math.random() * 256))
    const next = keystream(seed)

    plain.push(checksum(plain))

    return btoa(String.fromCharCode(...seed, ...plain.map((byte) => byte ^ next())))
}

/**
 * Protects a single element: decodes its value, removes the attribute, renders the text and handles clicks.
 *
 * The listeners only keep the encoded value. Text and link are decoded again whenever they're needed.
 *
 * @param {Element} el
 */
function protect(el) {
    const encoded = el.getAttribute('data-spamguard')
    const value = encoded && el.isConnected && decode(encoded)

    // Nothing to do, already protected (the attribute is gone), not in the document (no styles to render with) or invalid
    if (!value) return

    // Leave no trace of the value in the DOM
    el.removeAttribute('data-spamguard')

    const clickable = value.link.length > 0
    const visible = value.text.length > 0 && !hasFlag(el, 'content')
    let revealOnClick = visible && hasFlag(el, 'reveal')

    if (visible && !revealOnClick) render(el, encoded)
    if (!clickable && !revealOnClick) return

    el.addEventListener('click', (event) => {
        event.preventDefault()

        // Only real user input counts, not el.click() or dispatchEvent() from scripts
        if (!event.isTrusted) return

        if (revealOnClick) {
            // data-reveal: the first click shows the value, the following ones open the link. The canvas has no
            // accessible name, so the placeholder text stays as one.
            revealOnClick = false
            if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.textContent.trim())
            render(el, encoded)
        } else if (clickable) {
            let href = ''

            // Joined with +=, as a hook on join() & co. would see the whole link
            for (const char of toChars(decode(encoded).link)) href += char

            window.location.href = href
        }
    })
}

/**
 * Replaces the content of the element with a canvas that shows the text, and keeps it up to date.
 *
 * Redraws when inherited styles change (hover, dark mode, responsive font sizes, …), once web fonts have loaded, when
 * the zoom level or the screen changes and when the canvas is shown again after display: none.
 *
 * @param {Element} el
 * @param {string} encoded Value of the data-spamguard attribute
 */
function render(el, encoded) {
    const canvas = document.createElement('canvas')
    const style = getComputedStyle(el)
    const draw = () => paint(canvas, encoded)

    setStyle(canvas, CANVAS_STYLE, 'important')
    setStyle(canvas, { height: 'auto', 'max-width': '100%' })
    el.replaceChildren(canvas)
    draw()

    TRANSITION_EVENTS.forEach((type) =>
        canvas.addEventListener(type, (event) => {
            event.stopPropagation()
            if (type === 'transitionend') draw()
        })
    )

    document.fonts.load(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`).then(draw, () => {})
    watchZoom(new WeakRef(canvas), encoded)

    // No transitions run inside display: none, so redraw when the canvas is shown again (its size changes from 0). In
    // the next frame, as resizing the canvas within the callback would report a ResizeObserver loop error.
    new ResizeObserver(() => requestAnimationFrame(draw)).observe(canvas)
}

/**
 * Redraws the canvas when the zoom level or the screen changes, as long as it's in the document.
 *
 * The media query for the current pixel ratio stops matching when the ratio changes. It's watched once and renewed for
 * the new ratio after each change. Browsers keep media query listeners alive, so the canvas is only referenced weakly:
 * a removed canvas can be freed right away, not only after the next change.
 *
 * @param {WeakRef<HTMLCanvasElement>} canvasRef
 * @param {string} encoded Value of the data-spamguard attribute
 */
function watchZoom(canvasRef, encoded) {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
        'change',
        () => {
            const canvas = canvasRef.deref()

            if (!canvas?.isConnected) return
            paint(canvas, encoded)
            watchZoom(canvasRef, encoded)
        },
        { once: true }
    )
}

/**
 * Draws the text on the canvas in the canvas' current style, and lays the canvas out like a line of text.
 *
 * Everything is drawn in device pixels, so the text is as sharp as real text. Each character is drawn alone at the
 * same spot of the scratch canvas, then copied into place: hooks on measureText() and fillText() only ever see single
 * characters, in random order and without their positions.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} encoded Value of the data-spamguard attribute
 */
function paint(canvas, encoded) {
    const style = getComputedStyle(canvas)
    const pixelRatio = devicePixelRatio
    const fontSize = parseFloat(style.fontSize) * pixelRatio

    // Not in the document (anymore), or font-size: 0
    if (!(fontSize > 0)) return

    const font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
    const letterSpacing = (parseFloat(style.letterSpacing) || 0) * pixelRatio // NaN for normal
    const lineHeight = parseFloat(style.lineHeight) * pixelRatio // NaN for normal
    const chars = toChars(decode(encoded).text, style.textTransform)
    const drawOrder = shuffle(chars.keys())
    const padding = Math.ceil(fontSize / 4) // Room for glyphs that overhang their advance width (italics, …)
    const advances = []
    let metrics

    if (!scratch) scratch = document.createElement('canvas')

    const scratchContext = scratch.getContext('2d')

    // Measure the width of each character
    scratchContext.font = font
    drawOrder.forEach((i) => {
        metrics = scratchContext.measureText(chars[i])
        advances[i] = metrics.width + letterSpacing
    })

    // The font bounding box is the same for every character of a font, so the last measured one will do
    const ascent = Math.ceil(metrics.fontBoundingBoxAscent)
    const descent = Math.ceil(metrics.fontBoundingBoxDescent)
    const leading = lineHeight ? (lineHeight - ascent - descent) / 2 : 0 // Above and below the text
    const underline = getUnderline(style, fontSize, ascent, pixelRatio)
    // How far the canvas reaches below the text, if the underline is further down than the descent
    const overflow = underline ? Math.max(0, underline.top + underline.thickness - ascent - descent) : 0

    // Horizontal position of each character
    const lefts = []
    let width = 0

    advances.forEach((advance, i) => {
        lefts[i] = padding + width
        width += advance
    })

    // Resizing a canvas resets its context, so the font is set again afterwards. The scratch canvas has 1px more for the
    // fraction of the position.
    canvas.width = Math.ceil(width) + 2 * padding
    canvas.height = ascent + descent + overflow
    scratch.width = Math.ceil(Math.max(...advances)) + 2 * padding + 1
    scratch.height = ascent + descent
    scratchContext.font = font
    scratchContext.fillStyle = style.color

    const context = canvas.getContext('2d')

    // A character is drawn at the fraction of its position and copied at the whole pixels, which keeps its exact position
    drawOrder.forEach((i) => {
        const left = Math.floor(lefts[i])

        scratchContext.clearRect(0, 0, scratch.width, scratch.height)
        scratchContext.fillText(chars[i], padding + lefts[i] - left, ascent)
        context.drawImage(scratch, left - padding, 0)
    })

    if (underline) {
        context.fillStyle = style.textDecorationColor
        context.fillRect(padding, underline.top, width, underline.thickness)
    }

    // Same baseline and line height as text. Padding and overflow hang into the margins, so they take up no space.
    setStyle(canvas, {
        width: `${canvas.width / pixelRatio}px`,
        margin: [leading, -padding, leading - overflow].map((px) => `${px / pixelRatio}px`).join(' '),
        'vertical-align': `${-(descent + leading) / pixelRatio}px`,
    })
}

/**
 * Computes the underline of links. Replaced elements like <canvas> get no text decoration, so it's drawn by hand.
 *
 * Follows text-underline-offset and text-decoration-thickness. For auto, it uses 1/8 and 1/16 of the font size.
 *
 * @param {CSSStyleDeclaration} style Computed style of the canvas
 * @param {number} fontSize In device pixels
 * @param {number} ascent In device pixels
 * @param {number} pixelRatio
 * @returns {{ top: number, thickness: number } | null} In device pixels, null without underline
 */
function getUnderline(style, fontSize, ascent, pixelRatio) {
    if (!style.textDecorationLine.includes('underline')) return null

    const offset = parseFloat(style.textUnderlineOffset) // NaN for auto
    const thickness = parseFloat(style.textDecorationThickness) * pixelRatio // NaN for auto and from-font

    return {
        top: Math.round(ascent + (Number.isNaN(offset) ? fontSize / 8 : offset * pixelRatio)),
        thickness: Math.max(1, Math.round(thickness || fontSize / 16)),
    }
}

/**
 * Reads a boolean data attribute: enabled when present, unless set to "false".
 *
 * @param {Element} el
 * @param {string} name Without the data- prefix
 * @returns {boolean}
 */
function hasFlag(el, name) {
    return el.hasAttribute(`data-${name}`) && el.getAttribute(`data-${name}`) !== 'false'
}

/**
 * Sets inline styles.
 *
 * @param {HTMLElement} el
 * @param {Record<string, string>} style CSS property names and values
 * @param {string} [priority] "important" or nothing
 */
function setStyle(el, style, priority) {
    Object.entries(style).forEach(([name, value]) => el.style.setProperty(name, value, priority))
}

/**
 * Turns code points into strings, one per code point. They're created in random order, so hooks on
 * String.fromCodePoint() & co. only ever see an anagram.
 *
 * @param {number[]} codePoints
 * @param {string} [textTransform] Computed text-transform. Only uppercase and lowercase are applied.
 * @returns {string[]} In the order of the code points
 */
function toChars(codePoints, textTransform) {
    const chars = []

    shuffle(codePoints.keys()).forEach((i) => {
        const char = String.fromCodePoint(codePoints[i])

        chars[i] = textTransform === 'uppercase' ? char.toUpperCase() : textTransform === 'lowercase' ? char.toLowerCase() : char
    })

    return chars
}

/**
 * Returns the items in random order, by sorting them by a random number each.
 *
 * @template T
 * @param {Iterable<T>} items
 * @returns {T[]}
 */
function shuffle(items) {
    return [...items]
        .map((item) => [Math.random(), item])
        .sort(([a], [b]) => a - b)
        .map(([, item]) => item)
}

/**
 * Decodes a value of the data-spamguard attribute.
 *
 * Format: base64( seed + xor( varint(link length) + varint(code point)… + checksum ) )
 *
 * - seed: 4 random bytes, the key for the keystream that all following bytes are XORed with
 * - link length: number of code points of the link. They come first, followed by the code points of the text.
 * - checksum: sum of all bytes before it, modulo 256. Catches most damaged or random values (all but 1 in 256).
 *
 * This is obfuscation, not encryption (the key is part of the value). But it leaves no recognizable pattern, and the
 * plain value never passes through a built-in function as a whole string, where a hook could log it.
 *
 * @param {string} encoded
 * @returns {{ link: number[], text: number[] } | undefined} Code points of link and text, undefined if invalid. Script
 * links are returned empty.
 */
function decode(encoded) {
    let bytes

    try {
        bytes = [...atob(encoded)].map((char) => char.charCodeAt(0))
    } catch {
        return // Not Base64
    }

    const next = keystream(bytes.splice(0, SEED_LENGTH))
    const plain = bytes.map((byte) => byte ^ next())
    const check = plain.pop()
    const values = []
    let value = 0

    // Varints, see varint()
    plain.forEach((byte) => {
        value = (value << 7) | (byte & 0x7f)

        if (byte < 0x80) {
            values.push(value)
            value = 0
        }
    })

    const [linkLength, ...codePoints] = values
    const valid =
        check === checksum(plain) &&
        linkLength >= 0 && // Can be negative, if a made-up varint overflows
        linkLength <= codePoints.length &&
        codePoints.every((codePoint) => codePoint >= 0 && codePoint <= MAX_CODE_POINT)

    if (!valid) return

    const link = codePoints.slice(0, linkLength)

    return { link: isScript(link) ? [] : link, text: codePoints.slice(linkLength) }
}

/**
 * Tells whether a link runs code. Such links are never opened, in case a value was injected through user generated
 * content. Like browsers, it ignores whitespace and control characters in the scheme.
 *
 * @param {number[]} link Code points
 * @returns {boolean}
 */
function isScript(link) {
    // Without a colon, there is no scheme. Code points up to 0x20 (space) are whitespace and control characters.
    const scheme = link.slice(0, Math.max(link.indexOf(COLON), 0)).filter((codePoint) => codePoint > 0x20)

    return SCRIPT_SCHEMES.includes(String.fromCodePoint(...scheme).toLowerCase())
}

/**
 * Encodes a number as a varint: 7 bits per byte, most significant first. The high bit (0x80) marks that more bytes
 * follow, so small numbers take a single byte.
 *
 * @param {number} number Integer from 0 to 2^31 - 1. decode() reads varints as signed 32-bit integers.
 * @returns {number[]} Bytes
 */
function varint(number) {
    const bytes = [number & 0x7f]

    while ((number >>>= 7)) bytes.unshift((number & 0x7f) | 0x80)

    return bytes
}

/**
 * Sums up bytes, modulo 256.
 *
 * @param {number[]} bytes
 * @returns {number} Byte
 */
function checksum(bytes) {
    return bytes.reduce((sum, byte) => sum + byte, 0) & 0xff
}

/**
 * Creates a stream of pseudo-random bytes (xorshift32). The same seed always gives the same bytes, which lets decode()
 * undo the XOR of encode().
 *
 * @param {number[]} seed 4 bytes
 * @returns {() => number} Returns the next byte: the top 8 bits of the state
 */
function keystream(seed) {
    // A state of 0 would only ever produce zeros
    let state = seed.reduce((state, byte) => (state << 8) | byte, 0) || 1

    return () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5

        return state >>> 24
    }
}

// jQuery plugin, $('[data-spamguard]').spamguard(). Only available if jQuery is loaded before spamguard.js.
const jQuery = globalThis.jQuery

if (jQuery && jQuery.fn) {
    jQuery.fn.spamguard = function () {
        spamguard(this)
        return this
    }
}
