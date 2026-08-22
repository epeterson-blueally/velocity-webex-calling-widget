// ESLint flat config — focused on the Phase 3 exit criterion:
// "@typescript-eslint/no-floating-promises (type-checked lint)".
//
// We deliberately keep the rule set narrow (the two promise-safety rules, which
// require type information) rather than the full recommended-type-checked set, so
// the signal is exactly "no unhandled/misused promises" — every SDK call must be
// awaited or explicitly voided with error handling — without drowning in
// no-unsafe-* noise from the SDK's heavily-cast typings.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'reference/**',
      'coverage/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
