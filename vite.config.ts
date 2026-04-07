import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "HoverLens - CtrlCtrl Image Preview",
        namespace: "https://github.com/TnZzZHlp/hoverlens",
        version: "1.0.1",
        description: "悬停图片后双击 Ctrl 打开全屏预览，支持滚轮缩放、拖拽、双击重置与快捷关闭。",
        match: ["*://*/*"],
        grant: "none",
        "run-at": "document-idle",
      },
    }),
  ],
});
