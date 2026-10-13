# 卡拉比–丘投影可调视觉模型

单文件 WebGL2 页面，无外部依赖。直接用浏览器打开 `index.html` 即可。

## 数学

可视化复曲面 `z₁^n₁ + z₂^n₂ = 1`（n₁ = n₂ = 5 即弦论中经典五次卡拉比–丘流形的二维切片），采用 Hanson 参数化：

```
z₁ = e^{2πi k₁/n₁} · cos(x+iy)^{2/n₁}
z₂ = e^{2πi k₂/n₂} · sin(x+iy)^{2/n₂}
x ∈ [0, π/2],  y ∈ [-a, a],  k₁ < n₁,  k₂ < n₂
```

共 n₁·n₂ 个补丁。ℂ² ≅ ℝ⁴ 中的点经 4D 旋转后投影到 3D：

```
(X, Y, Z) = (Re z₁, Re z₂, cos α · Im z₁ + sin α · Im z₂)
```

被丢弃的第四维 `-sin α · Im z₁ + cos α · Im z₂` 可作为颜色显示。

## 可调参数

| 参数 | 作用 |
| --- | --- |
| n₁, n₂ | 方程指数（2–10），决定补丁数量与对称性 |
| 延展 a | 参数 y 的范围，控制"喇叭"伸展程度 |
| 分辨率 | 每个补丁的网格细分 |
| 显示补丁 | 逐个显示补丁，观察拼合过程 |
| 投影角 α | 两个虚部混合成第三个坐标的角度 |
| 相位 φ₁, φ₂ | z₁、z₂ 各自复平面内的旋转（4D 旋转） |
| 补丁分离 | 将各补丁沿其中心方向推开 |
| 着色 | 按补丁 / 第四维坐标 / z₁ 辐角 / 参数棋盘 |
| 动画 | 自动旋转、α 扫描、相位流动 |

投影在顶点着色器中完成，法线由 4D 切向量投影后叉乘得到，所以调节投影参数时不需要在 CPU 上重建网格。

## 小红书小工具版（`minitool/`）

按 minitool-zip-builder 规范改写，打包产物为 `calabi-yau-minitool.zip`（`index.html` 位于 zip 根目录）：

- 脚本外置为经典脚本 `main.js`（ES2017），无内联脚本 / 行内事件 / 外部资源
- WebGL 1 渲染；DPR ≤ 1.5、像素 ≤ 200 万、三角形 ≤ 10 万，持续掉帧自动降为省电档（DPR 1、5 万三角形），再不行则暂停动画
- 页面隐藏时暂停渲染；处理 `webglcontextlost` / `restored`；无 WebGL 时显示 `fallback.webp` 静态预览
- 下载改为容器能力：`writeTempFile` → `saveImageToPhotosAlbum`（保存相册）/ `postNote`（发布笔记），非容器环境显示预览提示
- CSS 以 Chrome 61 为基线，毛玻璃通过 `@supports` 增强，安全区使用 `var(--safe-area-inset-*, env(...))`

重新打包：`cd calabi-yau/minitool && zip -r -X ../calabi-yau-minitool.zip . -x '*.DS_Store'`
