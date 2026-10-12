import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    functions: {
      api: { name: "api", source: "./hello.ts" },
    },
  },
});
