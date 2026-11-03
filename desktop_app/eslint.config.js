const js = require("@eslint/js");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");
const react = require("eslint-plugin-react");

module.exports = [
  { ignores: ["node_modules/**", "web/dist/**", "dist/**", "build/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  js.configs.recommended,
  {
    files: ["backend/**/*.js", "electron/**/*.js", "eslint.config.js", "web/vite.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["web/src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // ANSI escape stripping uses  on purpose.
      "no-control-regex": "off",
    },
  },
];
