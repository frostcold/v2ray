# 卡拉比–丘投影 · 小红书小工具版

可调参数的卡拉比–丘流形（z₁ⁿ¹ + z₂ⁿ² = 1，Hanson 参数化）4D→3D 投影模型，按小红书小工具（minitool-zip-builder）规范实现。

## 实现说明（`minitool/`）

按 minitool-zip-builder 规范改写，打包产物为 `calabi-yau-minitool.zip`（`index.html` 位于 zip 根目录）：

- 脚本外置为经典脚本 `main.js`（ES2017），无内联脚本 / 行内事件 / 外部资源
- WebGL 1 渲染；DPR ≤ 1.5、像素 ≤ 200 万、三角形 ≤ 10 万，持续掉帧自动降为省电档（DPR 1、5 万三角形），再不行则暂停动画
- 页面隐藏时暂停渲染；处理 `webglcontextlost` / `restored`；无 WebGL 时显示 `fallback.webp` 静态预览
- 下载改为容器能力：`writeTempFile` → `saveImageToPhotosAlbum`（保存相册）/ `postNote`（发布笔记），非容器环境显示预览提示
- CSS 以 Chrome 61 为基线，毛玻璃通过 `@supports` 增强，安全区使用 `var(--safe-area-inset-*, env(...))`

重新打包：`cd calabi-yau/minitool && zip -r -X ../calabi-yau-minitool.zip . -x '*.DS_Store'`

## 发布前验证

上传 `calabi-yau-minitool.zip` 至创服平台，先在平台模拟器完成功能验证，再分别用 Android、iOS 真机扫码验证。发帖文案见 `发布文案.md`。
