import js from '@eslint/js'
import globals from 'globals'

export default [
    { ignores: ['dist/'] },
    js.configs.recommended,
    {
        languageOptions: { globals: globals.browser },
        rules: {
            eqeqeq: 'error',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
]
