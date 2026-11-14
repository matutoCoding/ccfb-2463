# 石刻青铜器三维点云查看系统

面向石刻、青铜器等文物三维数字化成果的浏览器端点云查看与量测系统。
纯 TypeScript + WebGL2 实现，零运行时第三方依赖，重活（解析、八叉树构建、对比计算）全部在 Web Worker 中完成，主线程保持可交互。

## 功能

| 模块 | 能力 |
| --- | --- |
| 导入 | PLY（ASCII / 二进制小端大端）与 XYZ，Worker 后台解析；坏文件结构化报错并保留记录 |
| 八叉树 LOD | 分层网格下采样，节点存 IndexedDB；按相机距离/屏幕误差看哪加载哪，远处降细节；显存预算 LRU 驱逐 |
| 渲染 | WebGL2 点精灵 + FBO 离屏 + EDL 眼穹顶光照描边；真彩 / 高程 / 法线 / 差异四种配色 |
| 剖切 | 剖切面与剖切盒（手动 discard，兼容无 clip-distance 扩展的驱动）；剖面线导出 CSV（含 2D 剖面坐标） |
| 测量 | 距离、三角面积、角度，GPU 拾取选点，结果存 IndexedDB 并可加备注 |
| 对比 | 两次扫描叠加，Worker 计算最近邻距离场，按距离绿-黄-红上色，输出均值/RMS/分位数统计 |
| 视角 | 轨道相机、视角书签、1×/2×/3× 高分辨率 PNG 截图 |
| 设置 | 显存预算、点大小、LOD 误差、EDL 参数、背景色、自适应质量 |

## 快速开始

```bash
npm install
npm run dev          # 开发服务器 http://127.0.0.1:5173
```

生成测试点云（含 2200 万点带刻字石碑）：

```bash
npm run gen:data     # 输出到 test-data/
```

在「藏品列表」页点击或拖入 `test-data/` 下的 `.ply` / `.xyz` 文件即可导入。
`broken.ply` 是故意截断的坏文件，用于验证错误提示。

## 测试与构建

```bash
npm run typecheck    # 主工程类型检查
npm run build        # 类型检查 + 生产构建（Worker 独立分包）
node scripts/generate-pointcloud.mjs   # 生成测试数据
```

逻辑测试（解析器、坏文件、八叉树层级性质、测量几何，28 项断言）：

```bash
npx esbuild scripts/test-logic.ts --bundle --platform=node --format=esm \
  --outfile=dist-test/test-logic.mjs && node dist-test/test-logic.mjs
```

对比算法性能基准（Node 真实算力，300 万点对 300 万点）：

```bash
npx esbuild scripts/bench-compare.ts --bundle --platform=node --format=esm \
  --outfile=dist-test/bench.mjs && node dist-test/bench.mjs
```

## 测试数据

`scripts/generate-pointcloud.mjs` 零依赖生成：

- `stele_22m.ply` — **2220 万点**石碑（1.8×0.9×0.25 m），正面带凹陷刻字（含「馆藏石刻」汉字与纪年点阵），真彩 + 法线
- `bronze_bell_3m.ply` — 300 万点青铜钟形器，环带纹 + 绿锈色
- `bronze_bell_rescan_3m.ply` — 青铜钟二次扫描（8mm 平移 + 毫米噪声），用于对比
- `stele_sample.xyz` — 80 万点 XYZ 文本小样
- `broken.ply` — 头部合法、数据截断的坏文件

## 架构

```
src/
  core/
    types.ts            共享类型与默认设置
    math.ts             向量/矩阵/几何（列主序 Mat4）
    db.ts               IndexedDB：藏品、八叉树节点 blob、测量、书签、设置
    settings.ts         设置单例（持久化 + 订阅）
    importPipeline.ts   文件 → 解析 Worker → 八叉树 Worker → 落库
    camera.ts           轨道相机（near/far 动态跟随，保深度精度）
    octreeLoader.ts     LOD 选择、节点惰性取数、GPU 缓冲 LRU、拾取反查
    renderer.ts         WebGL2 渲染器（FBO + EDL + R32F 拾取 + 截图）
    measure.ts          测量几何、剖面 CSV
  workers/
    parsers.ts          PLY/XYZ 解析（结构化错误码）
    octree.ts           八叉树构建（4 字节对齐节点布局）
    parse.worker.ts / octree.worker.ts / compare.worker.ts
  renderer/shaders.ts   GLSL ES 3.00
  ui/                   路由 + 五个页面（藏品/查看器/测量/对比/设置）
scripts/
    generate-pointcloud.mjs   测试数据生成
    gen-rescan.mjs            二次扫描生成
    test-logic.ts             逻辑测试
    bench-compare.ts          对比性能基准
```

### 关键工程决策

- **坐标精度**：点坐标相对藏品 origin 存 Float32，origin 单独保存，避免大坐标吃掉浮点尾数。
- **节点布局**：每点步长填充到 4 字节对齐，整块 ArrayBuffer 可直接构造 Float32Array 视图。
- **拾取**：用 R32F 浮点附件编码点 ID（规避 ANGLE/D3D 上 R32UI `readPixels` 兼容性问题），正常渲染同步写拾取附件。
- **裁剪**：不依赖 `gl_ClipDistance` 扩展，顶点着色器输出裁剪符号、片元手动 discard。
- **对比性能**：参考云先做体素下采样（每格一个代表点），27 邻域查询复杂度 O(n)；300 万点对在常规算力下约 5 秒。

## 浏览器要求

需支持 WebGL2 与 `EXT_color_buffer_float`（Chrome/Edge 90+、Firefox 90+、Safari 15+）。
