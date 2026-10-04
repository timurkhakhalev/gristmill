import { builtinModules } from "node:module";
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Renderer imports cross into main through window.electronAPI. Helpers are
// mixed-runtime: these existing browser-safe modules are the explicit entries.
const rendererHelpers = [
  "activeMicRecovery",
  "agentToolPresentation",
  "builtinActions",
  "calendarAvailability",
  "calendarDescription",
  "chatRouting",
  "dictionaryImport",
  "dictionaryStartup",
  "geminiResponse",
  "llmRequestTimeout",
  "localASROrganization",
  "localModelSelections",
  "meetingAudioPipeline",
  "meetingClockSync",
  "meetingFileTranscription",
  "meetingFollowUpPrompt",
  "meetingJoinUrl",
  "meetingRecordingConfigSnapshot",
  "meetingRecordingRequest",
  "meetingRecordingSession",
  "micDeviceSelection",
  "micSelectionRecovery",
  "microphoneSelection",
  "noteFormattingOverrides",
  "reasoningRouting",
  "selfHostedTranscription",
  "speakerCount",
  "stripThinking",
  "transcriptionRoute",
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nodeModules = [...new Set(builtinModules.map((name) => name.replace(/^node:/, "")))];
const nodeImports = `^(?:node:|electron(?:/|$)|(?:${nodeModules.map(escapeRegex).join("|")})(?:/|$))`;
const mainImports = `(?:^|/)(?:helpers/(?!(?:${rendererHelpers.join("|")})(?:\\.[cm]?[jt]sx?)?$)|preload/|workers/|utils/(?:process|serverUtils)(?:\\.[cm]?[jt]s)?$|localReasoningBridge(?:\\.[cm]?[jt]s)?$)|^(?:\\.\\./)+(?:main|preload)(?:\\.[cm]?[jt]s)?$`;
const boundaryMessage =
  "Renderer cannot import Node/Electron or main implementation. Use window.electronAPI, a shared contract, or an approved browser-safe helper.";

// Export the same policy to the graph regression tests; do not duplicate rules.
export const rendererBoundaryRules = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        { regex: nodeImports, message: boundaryMessage },
        { regex: mainImports, message: boundaryMessage },
      ],
    },
  ],
  "no-restricted-globals": [
    "error",
    "process",
    "Buffer",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
  ],
  "no-restricted-syntax": [
    "error",
    ...[nodeImports, mainImports].map((pattern) => ({
      selector: `ImportExpression[source.value=/${pattern.replaceAll("/", "\\/")}/]`,
      message: boundaryMessage,
    })),
  ],
};

export const rendererSharedPolicyRoots = [
  "src/config/settingsSelectors.ts",
  "src/helpers/chatRouting.ts",
  "src/helpers/transcriptionRoute.ts",
];

export default [
  { ignores: ["dist", "helpers/**", "utils/**"] },
  // JS and JSX files (renderer - ES modules)
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_|^event|^err|^error" },
      ],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-useless-catch": "off",
      "no-async-promise-executor": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // TypeScript files
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: [
      "*.{ts,tsx,js,jsx}",
      "components/**/*.{ts,tsx,js,jsx}",
      "hooks/**/*.{ts,tsx,js,jsx}",
      "stores/**/*.{ts,tsx,js,jsx}",
      "services/**/*.{ts,tsx,js,jsx}",
      "models/**/*.{ts,tsx,js,jsx}",
      "lib/**/*.{ts,tsx,js,jsx}",
    ],
    ignores: ["services/localReasoningBridge.ts", "eslint.config.js"],
    rules: rendererBoundaryRules,
  },
];
