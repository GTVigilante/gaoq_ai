import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TYPESCRIPT_FILES = ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      'backend/**',
      'frontend/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPESCRIPT_FILES,
  })),
  {
    files: TYPESCRIPT_FILES,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  {
    files: ['**/*.config.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node
    }
  }
);
