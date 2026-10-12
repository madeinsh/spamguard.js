const OPTIONS = ['name', 'domain', 'tld', 'number', 'text', 'salt']

let sheet

const data = (el, name) => el.getAttribute(`data-${name}`)
const flag = (el, name) => el.hasAttribute(`data-${name}`) && data(el, name) !== 'false'

/**
 * Protects email addresses, phone numbers and texts from bots and scrapers.
 *
 * @param {string|Element|ArrayLike<Element>} target CSS selector, element, NodeList, array or jQuery object
 */
export default function spamguard(target) {
    const elements = typeof target === 'string' ? document.querySelectorAll(target) : target.nodeType ? [target] : target

    Array.from(elements).forEach(protect)
}

function protect(el) {
    const type = ['name', 'number', 'text'].find((name) => el.hasAttribute(`data-${name}`))

    // Nothing to do, or already protected (the source attributes are gone)
    if (!type) return

    const salt = data(el, 'salt') || ''
    const read = (name) => [...(data(el, name) || '')].filter((char) => !salt.includes(char)).join('')
    const value = type === 'name' ? `${read('name')}@${read('domain')}.${read('tld')}` : read(type)
    const href = flag(el, 'mailto') && link(el, type, value)

    // Leave no trace of the value in the DOM
    OPTIONS.forEach((name) => el.removeAttribute(`data-${name}`))

    if (!flag(el, 'content')) render(el, value)

    if (href) {
        el.addEventListener('click', (event) => {
            event.preventDefault()
            window.location.href = href
        })
    }
}

function link(el, type, value) {
    const message = data(el, 'message')

    if (type === 'name') {
        const query = [
            ['subject', data(el, 'subject')],
            ['body', message],
        ]
            .filter(([, text]) => text)
            .map(([key, text]) => `${key}=${encodeURIComponent(text)}`)
            .join('&')

        return `mailto:${value}${query ? `?${query}` : ''}`
    }

    if (type === 'number') {
        const protocol = data(el, 'protocol') || 'tel'

        if (protocol === 'whatsapp') {
            return `https://wa.me/${value.replace(/\D/g, '')}${message ? `?text=${encodeURIComponent(message)}` : ''}`
        }

        return `${protocol}:${value.replace(/\s/g, '')}`
    }
}

// Every character becomes an empty <span> whose content only exists as a hex-escaped CSS pseudo-element
function render(el, value) {
    el.replaceChildren(
        ...[...value].map((char) => {
            const span = document.createElement('span')

            span.className = `s${Math.random().toString(36).slice(2)}`
            insertRule(`.${span.className}::after{content:"\\${char.codePointAt(0).toString(16)}"}`)

            return span
        })
    )
}

// Rules live in a constructed stylesheet (no <style> text in the DOM, CSP-friendly) in random order
function insertRule(rule) {
    if (!sheet) {
        sheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    }

    sheet.insertRule(rule, Math.floor(Math.random() * (sheet.cssRules.length + 1)))
}

const jQuery = globalThis.jQuery

if (jQuery && jQuery.fn) {
    jQuery.fn.spamguard = function () {
        spamguard(this)
        return this
    }
}
