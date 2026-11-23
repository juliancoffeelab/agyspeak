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
import { migrationBoundaryRule } from "./eslint-rules/migration-boundary.mjs";

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
        {
          selector:
            "MemberExpression[object.name='Keyboard'][property.name!='dismiss']",
          message:
            "Layout follows the keyboard through Screen (src/ui/Screen.tsx); only Keyboard.dismiss() is used directly.",
        },
        {
          selector:
            "JSXOpeningElement[name.name='TextInput'] > JSXAttribute[name.name='value']",
          message:
            "React Native passes `value` to the native field on every render, so the app writes back what the user is typing and keys are lost. Use `defaultValue` with a text captured once, and write to the field through its ref.",
        },
        // A rule of thumb: a linter can't tell whether a value changes, so
        // `defaultValue` is held to a plain name or a literal, such as one
        // captured once with useState. It exists to catch lines like
        // `defaultValue={draft.value.text}`, which follow the typed text.
        {
          selector:
            "JSXOpeningElement[name.name='TextInput'] > JSXAttribute[name.name='defaultValue'] > JSXExpressionContainer > :not(Identifier, Literal, TemplateLiteral[expressions.length=0])",
          message:
            "`defaultValue` is passed to the native field on every render, not once, so it must not change with what is typed. Capture the starting text once.",
        },
      ],
      // A layer's edges have one owner, and everything shown over the routes
      // stays in the app's window. See src/ui/Screen.tsx and
      // src/ui/Overlay.tsx.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["KeyboardAvoidingView", "SafeAreaView"],
              message: "Lay the layer out with Screen (src/ui/Screen.tsx).",
            },
            {
              name: "react-native",
              importNames: ["Modal"],
              message:
                "Show it with Overlay (src/ui/Overlay.tsx): a Modal is a separate window and takes focus from the keyboard.",
            },
            {
              name: "react-native",
              importNames: ["Alert"],
              message:
                "Tell the person with notify (src/ui/notice.ts): a stock alert is a separate window and takes focus from the keyboard.",
            },
            {
              name: "react-native-safe-area-context",
              importNames: ["SafeAreaView", "SafeAreaProvider"],
              message: "Lay the layer out with Screen (src/ui/Screen.tsx).",
            },
            {
              name: "react-native-keyboard-controller",
              message:
                "Layout follows the keyboard through Screen (src/ui/Screen.tsx).",
            },
          ],
        },
      ],
    },
  },
  {
    // The keyboard's one owner, and the root that provides it.
    files: ["src/ui/Screen.tsx", "src/app/_layout.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["KeyboardAvoidingView", "SafeAreaView", "Modal"],
              message: "See src/ui/Screen.tsx and src/ui/Overlay.tsx.",
            },
          ],
        },
      ],
    },
  },
  {
    // Every module the toolchain accepts. Frozen-fixture tests are the one
    // exception: they may import individual historical steps.
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    ignores: ["tests/**"],
    plugins: {
      local: { rules: { "migration-boundary": migrationBoundaryRule } },
    },
    rules: {
      "local/migration-boundary": [
        "error",
        { root: rootDir, packages: ["zod"] },
      ],
    },
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
]);
