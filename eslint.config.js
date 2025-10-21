import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["**/*.d.ts"]),
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.strict,
  stylistic.configs.customize({
    quotes: "double",
    semi: true,
    arrowParens: true,
    braceStyle: "1tbs",
  }),
  {
    rules: {
      // typescript thinks classes with only static members are useless,
      // but that's how our models are written so turn this rule off
      "@typescript-eslint/no-extraneous-class": "off",
      // emulate how typescript deals with unused vars
      "@typescript-eslint/no-unused-vars": ["error", {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
      "@stylistic/max-len": ["error", {
        code: 140,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
      }],
      "@stylistic/object-curly-newline": ["error", {
        multiline: true,
        consistent: true,
      }],
      "@typescript-eslint/consistent-type-imports": ["error", {
        fixStyle: "separate-type-imports",
        prefer: "type-imports",
      }],
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // allow non-null assertions in tests because they can be useful for more concise tests
    files: ["test/**/*"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/consistent-type-imports": ["error", {
        disallowTypeAnnotations: false,
        fixStyle: "separate-type-imports",
        prefer: "type-imports",
      }],
    },
  },
]);
