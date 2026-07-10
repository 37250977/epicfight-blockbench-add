# EpicFight Blockbench JSON Plugin

> **下载插件**：[epicfight_export.js](https://raw.githubusercontent.com/37250977/epicfight-blockbench-add/main/epicfight_export.js)（右键 → 链接复制后再用「URL加载插件」导入 Blockbench）

这是一个面向 **EpicFight** 的 Blockbench 插件，用来在 Blockbench 中导入、编辑、再导出 EpicFight 使用的 `mesh / armature / animation` JSON 资源。

它的目标不是替代官方 Blender 插件，而是提供一条更适合 Blockbench 工作流的编辑链：

- 导入 EpicFight 官方 `mesh` 模型
- 导入 EpicFight 独立 `armature` 骨架
- 导入 EpicFight 动画
- 从 Blockbench 导出 EpicFight 模型和动画

## 适用场景

- 想在 Blockbench 中查看和修改 EpicFight 官方模型
- 想把 EpicFight 的骨架和动画拉进 Blockbench 继续调姿态
- 想从 Blockbench 导出可继续用于 EpicFight 的 JSON
- 想做 EpicFight addon 的模型、骨架、动画资产

## 安装

1. 打开 Blockbench
2. 进入 `文件 -> 插件 -> 从文件加载插件`
3. 选择 `epicfight_export.js`
4. 加载后，在 `文件 -> 导入` 和 `文件 -> 导出` 中会出现 EpicFight 相关菜单

也可以直接把 `epicfight_export.js` 拖进 Blockbench。

## 当前功能

### 导入

- `Import EpicFight Mesh JSON`
  - 导入 EpicFight 官方 `entity/*.json`
  - 支持几何、UV、骨架、顶点权重
- `Import EpicFight Armature JSON`
  - 导入独立骨骼文件
  - 只创建骨架，不要求有 mesh
- `Import EpicFight Animation JSON`
  - 导入 EpicFight 动画到当前 Blockbench 骨架
  - 兼容 `matrix` 和 `attributes` 两类动画格式

### 导出

- `Export as EpicFight Model JSON`
  - 可选择导出：
  - `Mesh Only`
  - `Armature Only`
  - `Mesh + Armature`
- `Export as EpicFight Animation JSON`
  - 可选择导出：
  - `attributes`
  - `matrix`
- `Batch Export EpicFight Animations`
  - 把当前项目中所有动画分别导出为独立 JSON 文件
  - 同样可选择 `attributes` 或 `matrix` 格式
  - 适合一次性导出整套动画资产
- `Export as EpicFight Entity JSON`
  - 把 mesh、armature 和所有动画打包导出到同一个 JSON 文件
  - 可分别选择 armature 和 animation 的格式（`attributes` / `matrix`）
  - 可勾选 `Optimize keyframes` 去除冗余关键帧
  - 这种结构最接近 EpicFight 官方 `entity` 模型文件

## 导出说明

### 模型导出

统一模型导出入口会在导出前弹出选择框：

- `Mesh Only`
  - 导出网格数据
- `Armature Only`
  - 导出骨架数据
- `Mesh + Armature`
  - 把网格和骨架一起导出到同一个 JSON 根对象中
  - 这种结构更接近 EpicFight 官方 `entity` 模型文件

推荐优先使用 `Mesh + Armature`，这样最方便回导和整体验证。

### 动画导出

动画导出也会在导出前弹出选择框：

- `attributes`
  - 导出为 `loc / rot / sca`
  - 更适合属性型动画工作流
- `matrix`
  - 导出为 16 项矩阵数组
  - 更接近 EpicFight 原生矩阵动画表现

### 批量导出动画

`Batch Export EpicFight Animations` 会把当前项目里**所有动画**分别导出为独立的 JSON 文件，适合一次性产出整套动画资产。

弹窗选项：

- `Format`：`attributes` 或 `matrix`，与单个动画导出一致
- `Optimize keyframes`：勾选后去除连续相同的冗余关键帧

输出规则：

- 每个动画一个文件，文件名为 `{动画名}_{格式}.json`
  - 例如 `idle_attributes.json`、`walk_matrix.json`
- 动画名中的 `<>:"/\|?*` 等非法字符会被替换为 `_`
- 没有可导出关键帧的动画会被跳过，并在最终汇总中列出
- 导出完成后会弹出 toast 提示成功 / 跳过 / 失败数量，必要时弹出详细列表

### Entity 导出

`Export as EpicFight Entity JSON` 会把 **mesh + armature + 全部动画**打包到同一个 JSON 文件中，结构最接近 EpicFight 官方 `animmodels/entity/*.json`。

弹窗选项：

- `Armature Format`：骨架部分使用 `attributes` 或 `matrix`
- `Animation Format`：动画部分使用 `attributes` 或 `matrix`
  - 两种格式可以独立选择，例如骨架用 `matrix`、动画用 `attributes`
- `Optimize keyframes`：去除动画中连续相同的冗余关键帧

输出结构：

```json
{
    "vertices": { ... },
    "armature": { "joints": [...], "hierarchy": [...] },
    "armature_format": "attributes",
    "animation": [ ... ],
    "format": "attributes",
    "fps": 20
}
```

- 当项目里没有任何动画时，`animation` 和 `format` 字段会被省略
- 当动画格式为 `matrix` 时，顶层 `format` 字段会被省略（EpicFight 约定 matrix 格式不带 `format` 字段）

## 典型工作流

### 工作流 1：查看官方模型

1. 在 Blockbench 里选择 `Import EpicFight Mesh JSON`
2. 选择官方 `animmodels/entity/*.json`
3. 插件会导入 mesh、armature 和权重
4. 然后你可以直接查看、编辑、权重检查

### 工作流 2：编辑骨架

1. 选择 `Import EpicFight Armature JSON`
2. 导入独立骨架文件
3. 在 Blockbench 中编辑骨架层级和静止姿态
4. 再用 `Export as EpicFight Model JSON -> Armature Only` 导出

### 工作流 3：编辑动画

1. 先导入 mesh 或 armature
2. 切到 Blockbench 动画模式
3. 选择 `Import EpicFight Animation JSON`
4. 修改关键帧
5. 用 `Export as EpicFight Animation JSON` 选择 `attributes` 或 `matrix` 导出

## 文件结构示例

### `Mesh + Armature`

```json
{
    "positions": { "stride": 3, "count": 0, "array": [] },
    "uvs": { "stride": 2, "count": 0, "array": [] },
    "normals": { "stride": 3, "count": 0, "array": [] },
    "vcounts": { "stride": 1, "count": 0, "array": [] },
    "weights": { "stride": 1, "count": 0, "array": [] },
    "vindices": { "stride": 1, "count": 0, "array": [] },
    "parts": {},
    "armature_format": "attributes",
    "armature": {
        "joints": [],
        "hierarchy": []
    },
    "fps": 20
}
```

### `Animation Attributes`

```json
{
    "format": "attributes",
    "animation": [
        {
            "name": "BoneName",
            "time": [0.0, 0.1],
            "transform": [
                { "loc": [0, 0, 0], "rot": [1, 0, 0, 0], "sca": [1, 1, 1] }
            ]
        }
    ],
    "fps": 20
}
```

### `Animation Matrix`

```json
{
    "animation": [
        {
            "name": "BoneName",
            "time": [0.0, 0.1],
            "transform": [
                [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
            ]
        }
    ],
    "fps": 20
}
```

## 当前特性说明

- 已支持 EpicFight 官方 mesh JSON 导入
- 已支持独立 armature JSON 导入
- 已支持动画 `matrix / attributes` 双格式导入
- 已支持模型导出时把 `mesh` 和 `armature` 合并到一个文件
- 已支持动画导出时选择 `matrix` 或 `attributes`
- 已支持批量导出所有动画为独立文件
- 已支持把 mesh + armature + 动画打包为单个 entity JSON

## 当前限制

- `Coord` 这类特殊动作轨目前仍以预览近似为主，不代表完全等价于游戏内运行时行为
- 少数复杂技能动画可能仍受 EpicFight 运行时代码影响，无法只靠 JSON 在 Blockbench 中百分百还原
- 一些导出结果虽然结构正确，仍建议通过“导出后再导回”做 round-trip 验证

## 参考

- EpicFight 官方 Blender 插件：
  [blender-json-addon](https://github.com/Yesssssman/blender-json-addon)
- Blockbench 插件文档：
  [Plugin API](https://www.blockbench.net/wiki/docs/plugin)
