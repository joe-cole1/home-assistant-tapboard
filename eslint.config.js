import js from '@eslint/js';
import globals from 'globals';

const sharedRules = {
  ...js.configs.recommended.rules,
  eqeqeq: ['error', 'always'],
  'no-constant-binary-expression': 'error',
  'no-duplicate-imports': 'error',
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
      ignoreRestSiblings: true
    }
  ]
};

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**']
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: sharedRules
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser
    },
    rules: sharedRules
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: sharedRules
  }
];
