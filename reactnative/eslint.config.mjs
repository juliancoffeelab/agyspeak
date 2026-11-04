import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import react from "@eslint-react/eslint-plugin";
import reactNative from "@react-native/eslint-plugin";
import expo from "eslint-plugin-expo";
import hooks from "eslint-plugin-react-hooks";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import globals from "globals";
import tseslint from "typescript-eslint";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Keep React's official compiler diagnostics without duplicate hook diagnostics
// from the general React preset.
const duplicateHookRules = Object.fromEntries(
  Object.keys(
    react.configs["disable-conflict-eslint-plugin-react-hooks"].rules,
  ).map((name) => [name.replace("react-hooks/", "@eslint-react/"), "off"]),
);

export default defineConfig([
  globalIgnores([
    "android/**",
    "ios/**",
    ".expo/**",
    "dist/**",
    "artifacts/**",
    ".signing/**",
    "**/.env*",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      react.configs["recommended-typescript"],
      react.configs["disable-dom"],
      react.configs["disable-rsc"],
      hooks.configs.flat.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      globals: globals["react-native"],
      parserOptions: { projectService: true, tsconfigRootDir: rootDir },
    },
    plugins: { "@react-native": reactNative, expo },
    settings: {
      // Native implementation files use Flow syntax, not TypeScript. Import
      // existence is still checked; TypeScript checks the public API's exports.
      "import-x/ignore": ["node_modules/react-native/"],
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: `${rootDir}/tsconfig.json`,
          conditionNames: [
            "types",
            "react-native",
            "import",
            "require",
            "default",
          ],
          mainFields: ["types", "typings", "react-native", "module", "main"],
          extensions: [
            ".android.ts",
            ".native.ts",
            ".ts",
            ".android.tsx",
            ".native.tsx",
            ".tsx",
            ".d.ts",
            ".android.js",
            ".native.js",
            ".js",
            ".jsx",
            ".json",
          ],
        }),
      ],
    },
    rules: {
      ...duplicateHookRules,
      "@typescript-eslint/no-deprecated": "error",
      "@eslint-react/no-leaked-conditional-rendering": "error",
      "@react-native/platform-colors": "error",
      "@react-native/no-deep-imports": "error",
      "expo/no-dynamic-env-var": "error",
      "expo/no-env-var-destructuring": "error",
      "expo/use-dom-exports": "error",
      // Literal text under native containers. This guard does not resolve
      // aliases or inspect expression children like the old native plugin did.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXElement[openingElement.name.name=/^(View|ScrollView|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)$/] > JSXText[value=/\\S/]",
          message: "Wrap native container text in a Text component.",
        },
      ],
    },
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
]);
