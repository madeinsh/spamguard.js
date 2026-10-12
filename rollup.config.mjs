import { readFileSync, writeFileSync } from 'node:fs'
import terser from '@rollup/plugin-terser'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License | ${pkg.homepage} */`

// Keeps the copyright year in LICENSE.md up to date
const licenseYear = {
    name: 'license-year',
    buildStart() {
        const license = readFileSync('LICENSE.md', 'utf8')
        const updated = license.replace(/\(c\) \d{4}/i, `(c) ${new Date().getFullYear()}`)

        if (updated !== license) writeFileSync('LICENSE.md', updated)
    },
}

// Inlines the UMD build into the demo, so it runs standalone (e.g. on GitHub Pages)
const inlineExample = {
    name: 'inline-example',
    generateBundle(options, bundle) {
        const { code } = Object.values(bundle)[0]
        const html = readFileSync('example/index.html', 'utf8')

        writeFileSync('example/index.html', html.replace(/(<script id="spamguard">)[\s\S]*?(<\/script>)/, (_, open, close) => `${open}${code}${close}`))
    },
}

export default {
    input: 'src/spamguard.js',
    plugins: [licenseYear, terser()],
    output: [
        { file: pkg.module, format: 'es', banner },
        { file: pkg.main, format: 'umd', name: 'spamguard', exports: 'default', banner, plugins: [inlineExample] },
    ],
}
