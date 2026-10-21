# dsh-vim-desktop

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面端加一层 vim / Tridactyl 风格的键盘控制：三栏之间用 `hjkl` 走，链接和按钮用 `f` 贴标签点，`:` 开一个界面命令浮层。

鼠标仍然能用。插件只在 NORMAL 模式下接管裸键，带 `Cmd/Ctrl/Alt` 的组合一律放行。

## 安装

```sh
dsh plugin --profile web add github:jtesjh/dsh-vim-desktop
```

装完重启 dsh-desktop。本包没有构建步骤，直接从 GitHub 装即可。

> 如果你的 `dsh` 是同名的 Distributed Shell（Arch 上的 `dsh` 包），要显式调用 Node 版 CLI：
> `node <harness>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add ...`

## 键位

### 移动

| 键 | 作用 |
|---|---|
| `h` / `l` | 在「工作区」里换工作区（收起会自动展开）；在别处左右换栏 |
| `j` / `k` | 会话里滚一行；工作区里走会话行；面板里走 tab |
| `d` / `u` | 会话半页 |
| `g g` / `G` | 会话顶部 / 底部 |
| `H` / `L` | 上一条 / 下一条会话 |
| `g s` | 工作区 ↔ 会话 互切 |
| `Enter` | 打开当前条目：会话行是打开，工作区行是展开/折叠，面板是切 tab |

### 模式

平常是 NORMAL，裸键全部由插件接管。

只有两件事会进 INSERT：

- 按 `i` 或 `g i` 聚焦输入框
- 用鼠标点进输入框

`Esc` 从 INSERT 退回 NORMAL，同时把焦点从输入框拿走。切页面、切会话都不改模式。

### 动作

| 键 | 作用 |
|---|---|
| `a` | 新会话 |
| `F` | 选文件（等价于在输入框里打 `/file`） |
| `f` | 给页面上可点的元素贴标签，按键即点 |
| `;` | 同样贴标签，但动作是复制：链接取 `href`，其余取文字 |
| `:` | 命令浮层 |

### 命令浮层

窗口上方居中，跟随主题配色。子序列匹配，`↑`/`↓` 选，`Enter` 执行，`Tab` 补全，`Esc` 关。

只做界面动作，不往对话里塞东西：

| 命令 | 作用 |
|---|---|
| `:help` | 键位速查 |
| `:reload` | 刷新页面（不会重载插件本体） |
| `:q` | 关窗退出 |

### 状态条

会话栏左下角：

```
NORMAL 会话 42%
INSERT 工作区 3/12
HINT copy a
```

模式 + 当前区域 + 位置（会话是滚动百分比，工作区 / 面板是第几条）。临时提示会短暂顶掉它。

## 已知限制

- 键位写死，没有配置项，也没有设置界面。
- 没有数字前缀（`3j`）、没有会话内搜索、没有 visual 选择。
- `F` 靠匹配界面上的「指令」按钮和「文件」菜单项，宿主换措辞会失效。
- hint 对嵌套元素各贴一个标签，小元素上的标签可能盖住内容。
- 只在 Linux 的 DOM 路径上验证过；Windows / macOS 的原生键盘桥接没有适配。
- 刷新或重启后，模式回到 NORMAL，当前区域回到会话。

## 开发

客户端半边是 `lib/client.js`，单个文件，没有构建步骤 —— 宿主把它当作 `window.__ModuleLoader__` 里的一段懒执行代码。

改完必须重启 dsh-desktop：客户端 bundle 是启动时读进内存并缓存的，刷新页面不生效。

最省事的迭代方式是绕过包管理器，直接把文件复制进已安装的那一代：

```sh
target=$(readlink -f "$HOME/.config/dsh-desktop/harness/profiles/web/node_modules/dsh-vim-desktop")
cp package.json cordis.patch.yml "$target"/
cp lib/*.js "$target"/lib/
```

然后重启应用。正式发布走 `pnpm pack` + tarball，或推 GitHub 之后重新 `dsh plugin ... add`。

## 许可

MIT
