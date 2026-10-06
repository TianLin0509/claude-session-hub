# 整理电脑桌面

左侧导航底部「整理桌面」包含文件归档与 Windows 图标排列。读取 Windows 实际桌面位置（含公共桌面），默认勾选普通文件与资料目录，保留启动入口；用户也可以勾选不需要留在桌面的快捷方式。系统、隐藏项目和目录链接自动保留。

| 按钮 | 作用 |
| --- | --- |
| 重新扫描 | 重新读取桌面文件、资料目录与启动入口，勾选的项目将被收走 |
| 收走并排齐 | 归档勾选项目，再把剩余桌面图标从上往下排齐，满一列后排右侧下一列 |
| 排齐图标 | 单独排列现有图标，保留现有文件与快捷方式的位置路径 |
| 还原归档 | 还原最近一次仍有待还原项目的文件归档，再自动排齐图标 |
| 打开归档 | 在资源管理器打开普通资料和入口的归档根目录 |

图标排列会开启 Windows 桌面的自动排列和左侧竖列排列，保持当前图标大小及其他显示设置。对桌面 Shell 视图直接调用 `IFolderView2::SetCurrentFolderFlags`，随后读取全部图标坐标与间距，核对逐列排列、竖列空隙与换列顺序；未能排列或核对会显示错误。单独排列不涉及文件搬迁；「还原归档」仅还原文件，图标继续保持竖列排列。

原生接口依据：[Microsoft 桌面图标操作示例](https://devblogs.microsoft.com/oldnewthing/20130318-00/?p=4933)、[FOLDERFLAGS](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/ne-shobjidl_core-folderflags)。接口顺序依据 Microsoft `win32metadata` 的 `ShObjIdl_core.h`。使用系统 PowerShell 和 C# 编译器，无新增安装依赖。

- 普通资料和启动入口：Windows 下 `C:/VibeData/Artifacts/Desktop-Archive/<时间与唯一编号>/`，资料与启动入口分开保存，不在桌面建分类目录。
- 旧 `claude-artifacts`：整体迁至 `~/AI-Artifacts/历史桌面产物/<时间与唯一编号>/claude-artifacts/`，内部结构保留。
- 新产物：当前项目 `artifacts/` 或 `output/`；跨项目重要交付为 `~/AI-Artifacts/`，规则以共享 `USER_CONTEXT.md` 为准。

「打开归档」进入普通资料目录；「还原归档」同名项目保留、逐项显示未还原原因。每次搬迁前写 JSON 记录、逐项更新，记录跨 Hub 实例共享。异常退出后若锁目录仍在，先核对记录，再人工处理 `.organizer-lock`，不会自动夺锁。文件已经搬迁成功但图标排列失败时，两项结果分别显示，保留归档成果并支持单独重试排列。

只在同一磁盘卷移动；跨卷、被占用或无权限的项目会留下，并显示原因。移动目录不扫描或改写内部文件。归档后原桌面绝对路径会改变；引用旧位置的脚本或收藏需要更新。不通过桌面 junction 保留旧路径，以免桌面继续出现目录。

开发验证：`node tests/unit-desktop-organizer.test.js`、`node tests/unit-desktop-icon-layout.test.js` 与 `node tests/e2e-desktop-organizer-cdp.js`。界面测试使用后台隔离 Hub 和临时模拟桌面，真实鼠标操作扫描、单独排列、归档后排列与还原后排列；测试不会排列用户的真实桌面。只在隔离数据根、临时目录及 E2E 标志都通过检查时启用模拟桌面，界面结果明确标注「隔离测试：模拟桌面」。原生 Windows 图标排列单独亲验，保存其真实图标坐标与核对结果。
