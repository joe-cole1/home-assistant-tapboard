import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "data/", "backups/"],
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "CSS",
          "CustomEvent",
          "EventSource",
          "FormData",
          "Option",
          "StorageEvent",
          "document",
          "fetch",
          "localStorage",
          "matchMedia",
          "window",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
