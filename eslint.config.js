import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'client/dist/**', 'coverage/**'] },
  {
    files: ['server/**/*.js', 'client/src/**/*.{js,jsx}', 'tests/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
    },
  },
];
