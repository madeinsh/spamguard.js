import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import spamguard from '../src/spamguard.mjs'

// ---------------------------------------------------------------------------------------------------------------------
// Fake browser: just enough DOM, CSSOM and canvas for spamguard.js. The canvas fakes record what is drawn where, so the
// tests can read the rendered text back from the glyph positions.
// ---------------------------------------------------------------------------------------------------------------------

const ASCENT = 29.4
const DESCENT = 7.2

/** Advance width of a glyph in device pixels: fractional and different per character, to catch rounding mistakes. */
const advance = (text) => 10.25 + (text.codePointAt(0) % 10)

/** Computed style of a protected element, like getComputedStyle() returns it. */
const baseStyle = {
    fontStyle: 'normal',
    fontWeight: '400',
    fontSize: '16px',
    fontFamily: 'Arial',
    letterSpacing: 'normal',
    lineHeight: '24px',
    textTransform: 'none',
    textDecorationLine: 'none',
    textUnderlineOffset: 'auto',
    textDecorationThickness: 'auto',
    color: 'rgb(0, 0, 0)',
    textDecorationColor: 'rgb(0, 0, 0)',
}

class FakeStyle {
    props = {}

    setProperty(name, value, priority = '') {
        this.props[name] = { value, priority }
    }

    value(name) {
        return this.props[name]?.value
    }
}

class FakeContext {
    constructor(canvas) {
        this.canvas = canvas
        this.reset()
    }

    // Like in browsers, resizing a canvas resets the state of its context
    reset() {
        this.font = '10px sans-serif'
        this.fillStyle = '#000000'
        this.glyph = null
    }

    measureText(text) {
        log.measured.push({ text, font: this.font })

        return { width: advance(text), fontBoundingBoxAscent: ASCENT, fontBoundingBoxDescent: DESCENT }
    }

    clearRect() {
        this.glyph = null
    }

    fillText(text, x, y) {
        log.filled.push(text)
        this.glyph = { text, x, y, font: this.font, color: this.fillStyle }
    }

    // Copies the glyph of the scratch canvas: its position on this canvas is the copy offset plus the glyph offset
    drawImage(source, x, y) {
        const glyph = source.getContext('2d').glyph

        this.canvas.glyphs.push({ ...glyph, x: x + glyph.x, y: y + glyph.y })
    }

    fillRect(x, y, width, height) {
        this.canvas.rects.push({ x, y, width, height, color: this.fillStyle })
    }
}

class FakeCanvas {
    #width = 300
    #height = 150
    #context = new FakeContext(this)
    parent = null
    listeners = {}
    style = new FakeStyle()
    glyphs = []
    rects = []
    paints = 0

    get width() {
        return this.#width
    }

    // spamguard.js sizes the canvas once per paint
    set width(value) {
        this.#width = value
        this.#context.reset()
        this.glyphs = []
        this.rects = []
        this.paints++
    }

    get height() {
        return this.#height
    }

    set height(value) {
        this.#height = value
        this.#context.reset()
    }

    get isConnected() {
        return Boolean(this.parent?.isConnected && this.parent.children.includes(this))
    }

    getContext() {
        return this.#context
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener
    }

    /** The rendered text, read from left to right */
    get text() {
        return [...this.glyphs]
            .sort((a, b) => a.x - b.x)
            .map((glyph) => glyph.text)
            .join('')
    }
}

class FakeElement {
    nodeType = 1
    isConnected = true
    listeners = {}
    children = []
    textContent = ''

    constructor(attributes = {}, style = {}) {
        this.attributes = { ...attributes }
        this.computed = { ...baseStyle, ...style }
    }

    getAttribute(name) {
        return this.attributes[name] ?? null
    }

    hasAttribute(name) {
        return name in this.attributes
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value)
    }

    removeAttribute(name) {
        delete this.attributes[name]
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener
    }

    replaceChildren(...nodes) {
        this.children = nodes
        nodes.forEach((node) => (node.parent = this))
    }

    get canvas() {
        return this.children[0]
    }
}

let log
let page
let fontsLoaded

globalThis.window = { location: {} }
globalThis.devicePixelRatio = 2
globalThis.getComputedStyle = (node) => (node.isConnected ? (node.computed ?? node.parent.computed) : {})
globalThis.matchMedia = (query) => ({ addEventListener: (type, listener, options) => log.media.push({ query, type, listener, options }) })
globalThis.ResizeObserver = class {
    constructor(callback) {
        this.callback = callback
    }

    observe(target) {
        log.observed.push({ target, callback: this.callback })
    }
}
globalThis.requestAnimationFrame = (callback) => log.frames.push(callback)
globalThis.document = {
    createElement: (tag) => {
        assert.equal(tag, 'canvas')
        return new FakeCanvas()
    },
    querySelectorAll: (selector) => {
        log.queried.push(selector)
        return page
    },
    fonts: {
        load: (font) => {
            log.fonts.push(font)
            return fontsLoaded
        },
    },
}

beforeEach(() => {
    log = { measured: [], filled: [], media: [], observed: [], queried: [], fonts: [], frames: [] }
    page = []
    fontsLoaded = Promise.resolve([])
    window.location = {}
    globalThis.devicePixelRatio = 2
})

/** A click event as the browser dispatches it, isTrusted is false for el.click() and dispatchEvent() */
function click(el, isTrusted = true) {
    const event = {
        isTrusted,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true
        },
    }

    el.listeners.click(event)

    return event
}

/** Protects a new element and returns what a visitor gets: the rendered text and the link opened by a click. */
function visit(encoded, attributes = {}, style = {}) {
    const el = new FakeElement({ 'data-spamguard': encoded, ...attributes }, style)

    window.location = {}
    spamguard(el)

    const text = el.canvas?.text ?? null

    if (el.listeners.click) click(el)

    return { el, text, link: window.location.href ?? null }
}

const tick = () => new Promise((resolve) => setTimeout(resolve))
const nextFrame = () => log.frames.splice(0).forEach((callback) => callback())

// ---------------------------------------------------------------------------------------------------------------------
// Reference implementation of the format, independent from the library. Values already published in HTML must keep
// working, so the format must never change by accident.
// ---------------------------------------------------------------------------------------------------------------------

function referenceVarint(number) {
    const bytes = [number % 128]

    for (number = Math.floor(number / 128); number > 0; number = Math.floor(number / 128)) bytes.unshift(128 + (number % 128))

    return bytes
}

function referenceKeystream(seed) {
    let state = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0 || 1

    return () => {
        state = (state ^ (state << 13)) >>> 0
        state = (state ^ (state >>> 17)) >>> 0
        state = (state ^ (state << 5)) >>> 0

        return state >>> 24
    }
}

/** Encodes raw plain bytes (varints) with a given seed, adding the checksum */
function referenceEncode(seed, plain) {
    const next = referenceKeystream(seed)
    const bytes = [...plain, plain.reduce((sum, byte) => sum + byte, 0) % 256]

    return toBase64([...seed, ...bytes.map((byte) => byte ^ next())])
}

function referenceDecode(encoded) {
    const bytes = fromBase64(encoded)
    const next = referenceKeystream(bytes.slice(0, 4))
    const cipher = bytes.slice(4)
    const plain = cipher.map((byte) => byte ^ next())
    const check = plain.pop()
    const values = []
    let value = 0

    for (const byte of plain) {
        value = value * 128 + (byte % 128)

        if (byte < 128) {
            values.push(value)
            value = 0
        }
    }

    const [length, ...codePoints] = values

    assert.equal(check, plain.reduce((sum, byte) => sum + byte, 0) % 256, 'checksum')

    return { link: String.fromCodePoint(...codePoints.slice(0, length)), text: String.fromCodePoint(...codePoints.slice(length)) }
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (encoded) => [...atob(encoded)].map((char) => char.charCodeAt(0))
const toPlain = (link, text) => [[...link].length, ...[...link, ...text].map((char) => char.codePointAt(0))].flatMap(referenceVarint)

// ---------------------------------------------------------------------------------------------------------------------

describe('encode()', () => {
    test('returns Base64 that looks different every time', () => {
        const values = new Set(Array.from({ length: 20 }, () => spamguard.encode('mark@gmail.com', 'mailto:mark@gmail.com')))

        assert.equal(values.size, 20)
        values.forEach((value) => assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/))
    })

    test('follows the documented format', () => {
        const link = 'mailto:märk@gmail.com?subject=Hi 😀'
        const text = 'märk@gmail.com 😀'

        assert.deepEqual(referenceDecode(spamguard.encode(text, link)), { link, text })
        assert.deepEqual(referenceDecode(spamguard.encode()), { link: '', text: '' })
    })

    test('normalizes the text to NFC', () => {
        assert.equal(referenceDecode(spamguard.encode('René')).text, 'René')
    })
})

describe('decoding', () => {
    test('reads values in the documented format', () => {
        const text = '+49 (0) 40 / 123 456 – ☎️'
        const link = 'tel:+4940123456'

        for (const seed of [[0, 0, 0, 0], [1, 2, 3, 4], [255, 0, 128, 7], [255, 255, 255, 255]]) {
            const visitor = visit(referenceEncode(seed, toPlain(link, text)))

            assert.equal(visitor.text, text, seed)
            assert.equal(visitor.link, link, seed)
        }
    })

    test('reads published values', () => {
        const { text, link } = visit('zN4CvIgLQ+6HZgRhe8DYO52YT9HdA/BsdyyNnwiGUexv3ItrDJiYGj4=')

        assert.equal(text, 'mark@gmail.com')
        assert.equal(link, 'mailto:mark@gmail.com')
    })

    test('round-trips any text and link', () => {
        const long = 'x'.repeat(200) // Longer than 127 characters: the length takes two bytes
        const cases = [
            ['mark@gmail.com', 'mailto:mark@gmail.com?subject=Hello'],
            ['+1 808 555 0123', 'https://wa.me/18085550123?text=Hi%20there!'],
            ['Jürgen Groß 😀 𝒳 中文', 'mailto:jürgen@groß.de'],
            [long, `https://example.com/?q=${long}`],
            ['Hello World!', ''],
        ]

        for (const [text, link] of cases) {
            const visitor = visit(spamguard.encode(text, link))

            assert.equal(visitor.text, text)
            assert.equal(visitor.link, link || null)
        }
    })

    test('skips invalid values and leaves them in place', () => {
        const valid = spamguard.encode('mark@gmail.com', 'mailto:mark@gmail.com')
        const bytes = fromBase64(valid)

        bytes[6] ^= 1 // Tampered: the checksum no longer matches. Bytes 0–3 are the seed and could match by chance.

        for (const encoded of ['!!!', '', 'AAAA', 'AAAAAAAA', toBase64(bytes)]) {
            const el = new FakeElement({ 'data-spamguard': encoded })

            spamguard(el)
            assert.equal(el.getAttribute('data-spamguard'), encoded)
            assert.deepEqual(el.children, [])
            assert.deepEqual(el.listeners, {})
        }
    })

    test('skips values with an impossible link length or invalid code points', () => {
        const tooLong = [...referenceVarint(5), 97]
        const negative = [0x88, 0x80, 0x80, 0x80, 0x00, 97] // 2^31 overflows the 32 bits of the decoder
        const invalidCodePoint = [0, ...referenceVarint(0x110000)]

        for (const plain of [tooLong, negative, invalidCodePoint]) {
            const el = new FakeElement({ 'data-spamguard': referenceEncode([9, 8, 7, 6], plain) })

            spamguard(el)
            assert.notEqual(el.getAttribute('data-spamguard'), null)
        }
    })
})

describe('links', () => {
    test('a real click opens the link, script clicks are ignored', () => {
        const link = 'mailto:märk@gmail.com?subject=Hi 😀'
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('', link) })

        spamguard(el)
        assert.equal(el.getAttribute('data-spamguard'), null)

        assert.equal(click(el, false).defaultPrevented, true)
        assert.equal(window.location.href, undefined)

        assert.equal(click(el).defaultPrevented, true)
        assert.equal(window.location.href, link)
    })

    test('script links are never opened', () => {
        for (const link of [' \tJaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'vbscript:x', 'DATA:text/html,x']) {
            const { el, text } = visit(spamguard.encode('Click me', link))

            assert.equal(text, 'Click me', link)
            assert.equal(el.listeners.click, undefined, link)
        }
    })

    test('links that only look like script links are opened', () => {
        for (const link of ['https://example.com/javascript:alert(1)', 'mailto:javascript@example.com', 'javascript']) {
            assert.equal(visit(spamguard.encode('', link)).link, link)
        }
    })

    test('the link never passes through a built-in function as a whole string', () => {
        const link = 'mailto:mark@gmail.com'
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('', link) })
        const seen = []
        const { fromCodePoint } = String
        const { join } = Array.prototype

        spamguard(el)

        String.fromCodePoint = (...args) => seen.push(fromCodePoint(...args)) && fromCodePoint(...args)
        Array.prototype.join = function (...args) {
            seen.push(join.apply(this, args))
            return join.apply(this, args)
        }

        try {
            click(el)
        } finally {
            String.fromCodePoint = fromCodePoint
            Array.prototype.join = join
        }

        assert.equal(window.location.href, link)
        assert.ok(seen.length > 0)
        seen.forEach((value) => assert.ok(!value.includes('mark'), value))
    })
})

describe('attributes', () => {
    test('data-content keeps the own content, the link still works', () => {
        const { el, text, link } = visit(spamguard.encode('mark@gmail.com', 'mailto:mark@gmail.com'), { 'data-content': '' })

        assert.equal(text, null)
        assert.deepEqual(el.children, [])
        assert.equal(link, 'mailto:mark@gmail.com')
    })

    test('data-content without a link does nothing but remove the value', () => {
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('mark@gmail.com'), 'data-content': '' })

        spamguard(el)
        assert.equal(el.getAttribute('data-spamguard'), null)
        assert.deepEqual(el.children, [])
        assert.deepEqual(el.listeners, {})
    })

    test('data-reveal shows the value after a real click, then opens the link', () => {
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('+1 808 555 0123', 'tel:+18085550123'), 'data-reveal': '' })

        el.textContent = ' Show phone number '
        spamguard(el)
        assert.deepEqual(el.children, [])
        assert.equal(log.filled.length, 0)

        click(el, false)
        assert.deepEqual(el.children, [])

        click(el)
        assert.equal(el.canvas.text, '+1 808 555 0123')
        assert.equal(el.getAttribute('aria-label'), 'Show phone number', 'the canvas has no accessible name')
        assert.equal(window.location.href, undefined)

        click(el)
        assert.equal(window.location.href, 'tel:+18085550123')
    })

    test('data-reveal keeps an own aria-label', () => {
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('+1 808 555 0123', 'tel:+18085550123'), 'data-reveal': '', 'aria-label': 'Call' })

        el.textContent = 'Show phone number'
        spamguard(el)
        click(el)
        assert.equal(el.getAttribute('aria-label'), 'Call')
    })

    test('data-reveal works without a link', () => {
        const el = new FakeElement({ 'data-spamguard': spamguard.encode('secret'), 'data-reveal': '' })

        spamguard(el)
        click(el)
        assert.equal(el.canvas.text, 'secret')
        click(el)
        assert.equal(el.children.length, 1)
    })

    test('data-reveal without text does nothing until the link is clicked', () => {
        const { el, link } = visit(spamguard.encode('', 'tel:123'), { 'data-reveal': '' })

        assert.deepEqual(el.children, [])
        assert.equal(link, 'tel:123')
    })

    test('flags set to "false" are disabled', () => {
        const { text } = visit(spamguard.encode('mark@gmail.com'), { 'data-content': 'false', 'data-reveal': 'false' })

        assert.equal(text, 'mark@gmail.com')
    })

    test('text without a link is not clickable', () => {
        const { el, text } = visit(spamguard.encode('Hello World!'))

        assert.equal(text, 'Hello World!')
        assert.equal(el.listeners.click, undefined)
    })
})

describe('targets', () => {
    const create = () => new FakeElement({ 'data-spamguard': spamguard.encode('a') })

    test('protects all [data-spamguard] elements by default', () => {
        page = [create(), create()]
        spamguard()

        assert.deepEqual(log.queried, ['[data-spamguard]'])
        page.forEach((el) => assert.equal(el.canvas.text, 'a'))
    })

    test('accepts a selector, an element, an array and array-likes', () => {
        page = [create()]
        spamguard('.contact')
        assert.deepEqual(log.queried, ['.contact'])
        assert.equal(page[0].canvas.text, 'a')

        const [el1, el2, el3] = [create(), create(), create()]

        spamguard(el1)
        spamguard([el2])
        spamguard({ 0: el3, length: 1 })
        ;[el1, el2, el3].forEach((el) => assert.equal(el.canvas.text, 'a'))
    })

    test('skips elements that are already protected or not in the document', () => {
        const el = create()
        const detached = create()

        spamguard(el)

        const canvas = el.canvas

        spamguard(el)
        assert.equal(el.canvas, canvas)

        detached.isConnected = false
        spamguard(detached)
        assert.notEqual(detached.getAttribute('data-spamguard'), null)
        assert.deepEqual(detached.children, [])
    })

    test('registers a jQuery plugin when jQuery is loaded first', async () => {
        const jQuery = { fn: {} }

        globalThis.jQuery = jQuery

        try {
            await import('../src/spamguard.mjs?jquery')
        } finally {
            delete globalThis.jQuery
        }

        const collection = { 0: create(), length: 1 }

        assert.equal(jQuery.fn.spamguard.call(collection), collection, 'chainable')
        assert.equal(collection[0].canvas.text, 'a')
    })
})

describe('rendering', () => {
    test('draws the text on a canvas, like a line of text', () => {
        const text = 'mark@gmail.com'
        const { el } = visit(spamguard.encode(text))
        const canvas = el.canvas
        const size = 32 // 16px at a device pixel ratio of 2
        const pad = size / 4
        const widths = [...text].map(advance)
        const ascent = Math.ceil(ASCENT)
        const descent = Math.ceil(DESCENT)
        const leading = (48 - ascent - descent) / 2 // line-height 24px at ratio 2

        assert.equal(canvas.text, text)
        assert.equal(canvas.width, Math.ceil(widths.reduce((sum, width) => sum + width)) + 2 * pad)
        assert.equal(canvas.height, ascent + descent)
        assert.deepEqual(
            canvas.glyphs.map((glyph) => glyph.x).sort((a, b) => a - b),
            widths.map((_, i) => pad + widths.slice(0, i).reduce((sum, width) => sum + width, 0))
        )
        canvas.glyphs.forEach((glyph) => {
            assert.equal(glyph.y, ascent)
            assert.equal(glyph.font, `normal 400 ${size}px Arial`)
            assert.equal(glyph.color, 'rgb(0, 0, 0)')
        })
        assert.equal(canvas.style.value('width'), `${canvas.width / 2}px`)
        assert.equal(canvas.style.value('margin'), `${leading / 2}px ${-pad / 2}px ${leading / 2}px`)
        assert.equal(canvas.style.value('vertical-align'), `${-(descent + leading) / 2}px`)
        assert.deepEqual(canvas.rects, [])
    })

    test('the canvas styles survive CSS resets', () => {
        const { style } = visit(spamguard.encode('a')).el.canvas

        assert.deepEqual(style.props.display, { value: 'inline', priority: 'important' })
        assert.deepEqual(style.props['transition-duration'], { value: '1ms', priority: 'important' })
        assert.deepEqual(style.props['max-width'], { value: '100%', priority: '' })
    })

    test('draws characters one by one, in random order', () => {
        const text = 'abcdefghijklmnopqrstuvwxyz'
        const { el } = visit(spamguard.encode(text))

        assert.equal(el.canvas.text, text)
        assert.notEqual(el.canvas.glyphs.map((glyph) => glyph.text).join(''), text)
        assert.equal(log.filled.length, text.length)
        log.filled.forEach((char) => assert.equal(char.length, 1))
        log.measured.forEach(({ text, font }) => assert.deepEqual([text.length, font], [1, 'normal 400 32px Arial']))
    })

    test('hooks on String.fromCodePoint() only see single characters', () => {
        const { fromCodePoint } = String
        const seen = []

        String.fromCodePoint = (...args) => seen.push(args.length) && fromCodePoint(...args)

        try {
            visit(spamguard.encode('mark@gmail.com'))
        } finally {
            String.fromCodePoint = fromCodePoint
        }

        assert.ok(seen.includes(1))
        seen.forEach((count) => assert.ok(count <= 1, `${count} code points at once`))
    })

    test('applies letter-spacing and text-transform', () => {
        assert.equal(visit(spamguard.encode('Mark'), {}, { textTransform: 'uppercase' }).text, 'MARK')
        assert.equal(visit(spamguard.encode('Mark'), {}, { textTransform: 'lowercase' }).text, 'mark')
        assert.equal(visit(spamguard.encode('Mark'), {}, { textTransform: 'capitalize' }).text, 'Mark')

        const tight = visit(spamguard.encode('Mark')).el.canvas.width
        const wide = visit(spamguard.encode('Mark'), {}, { letterSpacing: '1.5px' }).el.canvas.width

        assert.equal(wide - tight, 4 * 1.5 * 2)
    })

    test('draws the underline by hand', () => {
        const { el } = visit(spamguard.encode('ab'), {}, { textDecorationLine: 'underline', textDecorationColor: 'red' })
        const { canvas } = el
        const width = advance('a') + advance('b')

        // Defaults: offset 1/8 and thickness 1/16 of the font size
        assert.deepEqual(canvas.rects, [{ x: 8, y: 30 + 4, width, height: 2, color: 'red' }])
        assert.equal(canvas.height, 38)
    })

    test('the underline extends the canvas when it lies below the descent', () => {
        const style = { textDecorationLine: 'underline', textUnderlineOffset: '5px', textDecorationThickness: '2px' }
        const { canvas } = visit(spamguard.encode('ab'), {}, style).el
        const overflow = 30 + 10 + 4 - 38

        assert.deepEqual(canvas.rects.map(({ y, height }) => [y, height]), [[40, 4]])
        assert.equal(canvas.height, 38 + overflow)
        assert.equal(canvas.style.value('margin'), `2.5px -4px ${(5 - overflow) / 2}px`)
    })

    test('line-height normal adds no leading', () => {
        const { canvas } = visit(spamguard.encode('a'), {}, { lineHeight: 'normal' }).el

        assert.equal(canvas.style.value('margin'), '0px -4px 0px')
        assert.equal(canvas.style.value('vertical-align'), '-4px')
    })
})

describe('redrawing', () => {
    test('redraws on style changes and swallows the transition events', () => {
        const { canvas } = visit(spamguard.encode('a')).el
        const types = ['transitionrun', 'transitionstart', 'transitioncancel', 'transitionend']
        let stopped = 0

        assert.deepEqual(Object.keys(canvas.listeners).sort(), [...types].sort())

        for (const type of types) canvas.listeners[type]({ stopPropagation: () => stopped++ })

        assert.equal(stopped, 4)
        assert.equal(canvas.paints, 2)
        assert.equal(canvas.text, 'a')
    })

    test('redraws in the new style', () => {
        const { el } = visit(spamguard.encode('a'))

        el.computed = { ...el.computed, color: 'blue', fontSize: '20px' }
        el.canvas.listeners.transitionend({ stopPropagation() {} })

        assert.equal(el.canvas.glyphs[0].color, 'blue')
        assert.equal(el.canvas.glyphs[0].font, 'normal 400 40px Arial')
    })

    test('redraws once web fonts have loaded', async () => {
        const { el } = visit(spamguard.encode('a'), {}, { fontStyle: 'italic', fontWeight: '700', fontFamily: '"Open Sans", sans-serif' })

        assert.deepEqual(log.fonts, ['italic 700 16px "Open Sans", sans-serif'])
        assert.equal(el.canvas.paints, 1)
        await tick()
        assert.equal(el.canvas.paints, 2)
    })

    test('ignores fonts that fail to load', async () => {
        fontsLoaded = Promise.reject(new Error('network'))

        const { el } = visit(spamguard.encode('a'))

        await tick()
        assert.equal(el.canvas.paints, 1)
    })

    test('redraws in the next frame when the canvas is resized, e.g. shown again', () => {
        const { canvas } = visit(spamguard.encode('a')).el
        const [observation] = log.observed

        assert.equal(observation.target, canvas)
        observation.callback()
        assert.equal(canvas.paints, 1, 'resizing within the callback reports a ResizeObserver loop error')
        nextFrame()
        assert.equal(canvas.paints, 2)
    })

    test('redraws when the zoom level changes, as long as the canvas is in the document', () => {
        const { el } = visit(spamguard.encode('a'))
        const { canvas } = el

        assert.equal(log.media.length, 1)
        assert.deepEqual([log.media[0].query, log.media[0].type, log.media[0].options], ['(resolution: 2dppx)', 'change', { once: true }])

        globalThis.devicePixelRatio = 3
        log.media[0].listener()
        assert.equal(canvas.paints, 2)
        assert.equal(log.media[1].query, '(resolution: 3dppx)')
        assert.equal(canvas.style.value('width'), `${canvas.width / 3}px`)

        el.replaceChildren()
        log.media[1].listener()
        assert.equal(canvas.paints, 2)
        assert.equal(log.media.length, 2)
    })

    test('does not draw when the canvas is not in the document or the font size is 0', () => {
        const { el } = visit(spamguard.encode('a'))
        const { canvas } = el

        el.computed = { ...el.computed, fontSize: '0px' }
        canvas.listeners.transitionend({ stopPropagation() {} })
        assert.equal(canvas.paints, 1)

        el.isConnected = false
        log.observed[0].callback()
        nextFrame()
        assert.equal(canvas.paints, 1)
    })

    test('the zoom listener does not keep a removed canvas in memory', async () => {
        v8.setFlagsFromString('--expose-gc')

        const gc = vm.runInNewContext('gc')
        const canvas = (() => {
            const el = new FakeElement({ 'data-spamguard': spamguard.encode('a') })

            spamguard(el)

            return new WeakRef(el.canvas)
        })()

        // The element is gone. Browsers keep the media query listener (in log.media) alive, but not the ResizeObserver
        // of a removed canvas.
        log.observed = []
        await tick()
        gc()

        assert.equal(log.media.length, 1)
        assert.equal(canvas.deref(), undefined)
    })
})
