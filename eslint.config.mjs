import js from "@eslint/js";
import tseslint from "typescript-eslint";

const eslintConfig = [
  {
    ignores: [
      ".wrangler/**",
      "android/app/src/main/assets/public/**",
      "dist/**",
      "ios/App/App/public/**",
      "mobile/.expo/**",
      "mobile/ios/**",
      "node_modules/**",
      "cloudflare-env.d.ts",
      "public/sw.js",
      "src/global-types.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": "off",
      "no-self-assign": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
  {
    files: [
      "mobile/babel.config.js",
      "mobile/metro.config.js",
      "mobile/tailwind.config.js",
      "mobile/plugins/**/*.js",
    ],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
