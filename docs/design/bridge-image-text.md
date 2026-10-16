# 图片文字通道（候选 1，2026-10-17）

目标：公司与家里的 Agent 通过现有配对通道传递可还原的图片。完整单条消息严格小于 60,000 UTF-8 字节，可以超过普通问答的 2 万字限制。普通问答保持原有限制。

## 用户操作

1. 两端升级到支持图片的版本并保持配对，在联动页点“立即检查”。只有对端确认支持图片后，发送入口才可用。
2. 在已有 Q / H 问答里选择所属线程，再选择本机 PNG、JPEG 或 WebP 静态图片，填写可选说明。
3. 默认保持图片分辨率，先尝试 PNG，再尝试 WebP 有损压缩。压不下时明确失败并保留选择；勾选“允许在必要时缩小分辨率”才会缩小。发送前会检查实际完整消息的字节数。
4. 对端收到后在本机解码、校验并保存，界面可预览。已有会话忙时等待，关闭时尝试恢复，再通过现有提示提交管线通知图片路径。

“已发出”仅表示中转服务已接收；“已接收并校验”表示对端已恢复图片；“已通知会话”表示已通过会话提交管线。最后一项不证明 Agent 已经看图或理解图片，提交确认不确定时另行标注。需要对图片继续提问可沿用对应问答的追问工具；附图本身不新建问答轮次。

## 技术选择

- 使用 Chromium 自带的 Canvas 编解码，不新增运行时依赖，也不调用视觉模型或生成模型。支持静态 PNG / JPEG / WebP，拒绝 GIF、动画、其他文件、超过 16 MiB 或 2000 万像素的输入。
- 压缩发生在发送端。WebP 质量参数下限 0.72；这是编码器参数，不代表主观画质达到 72%。允许缩小时按固定尺寸阶梯尝试。中文小字是否清楚仍需看实际图。
- 原始输入会重新编码，不承诺和输入文件逐字节相同。接收文件必须和发送端最终压缩文件逐字节相同，用 SHA-256 检查；不经过 AI 重绘。
- 图片二进制和 UTF-8 元信息一起 AES-256-GCM 加密，再只做一次 Base64url。外层标记 `IMG1=` 符合现有中转服务的字符白名单，且不会和旧版无填充的 Base64url 消息混淆。不同消息格式使用独立 AAD。
- 每次发送都测量实际 HTTP JSON 正文 `{to,mid,blob}` 的 UTF-8 字节数，必须 `< 60000`。HTTP 头不计入文字内容预算。固定开销、加密标签、图注、标记均计入，图片预算一般约 43–44 KB。实际可用空间按元信息动态计算。
- 直接复用现有中转服务，不改服务端、不新增文件上传 API。通道中的图片仍属于图片内容，界面和工具明确标明用途。

## Agent 接口

家里：`send_image_company(thread, path, round?, caption?, allow_resize?)`、`company_images(thread?)`。

公司：`send_image_home(...)`、`home_images(thread?)`。

Q 与 H 两种线程都支持附图，调用身份必须是该线程的本机会话。新开的公司查询会话只挂图片工具，不获得 `ask_home` 的再次求助权限；使用独立 HMAC 通行证，不能靠请求字段扩大权限。没有挂 MCP 时可使用现有 CLI 的 `image` 和 `images` 子命令。

```powershell
& $env:HUB_ASK_HOME_CMD image --thread H-1017-01 --path D:\pictures\chart.png
& $env:HUB_ASK_HOME_CMD images --thread H-1017-01
node $env:HUB_BRIDGE_CLI image --thread Q-1017-01 --path D:\pictures\chart.png --allow-resize
```

## 恢复与限制

消息沿用配对代次、方向绑定和持久发件箱。图片记录与入队在一个 SQLite 事务中写入；断线可重发，重复接收不重复通知。解除配对、压缩期间更换对端、错误所属线程、篡改和格式不符会阻止错误投递。接收图片保存在本机 Hub 数据目录 `company-bridge/images/`，重新配对不自动删除历史图片。

普通历史记录只展示最近记录，后台待处理图片不会因界面列表条数限制被遗漏。通知会话不等同于把图片直接放进模型上下文；Agent 需用本机看图工具读取路径。旧版对端不会收到图片消息，必须完成能力协商。

此前“视觉服务 502”表示服务链路上网关收到上游异常响应，不能仅凭 502 推断具体故障。这条图片压缩和恢复路径不依赖视觉服务；中转 HTTP 服务本身仍可能出现网络或 5xx 故障，由现有发件箱处理重试。

## 验证边界

本候选只使用程序生成的图。单元测试覆盖预算边界、完整性、方向、代次、会话归属、Q/H 双向、离线恢复、解码失败和通知。界面测试使用两台真实隔离 Hub、Chromium 编解码和绑定 localhost 的现有 `relay_server.py`；问答线程为夹具，不连接公司通道，不上传公司图片，不调用模型。上线前需独立审核和两端升级；本候选未合入、未发布。

```powershell
node --test tests/unit-company-bridge-images.test.js tests/unit-ask-home.test.js tests/unit-company-bridge.test.js
node tests/e2e-bridge-images.js
node scripts/run_unit_tests.js
```

E2E 需已安装 Python Playwright，并通过 `HUB_E2E_RELAY` 指向现有中转服务脚本。缺省脚本位置沿用本机已有服务源码，测试服务只绑定 127.0.0.1，数据独立放在临时目录。

依据：[RFC 4648 Base64](https://www.rfc-editor.org/rfc/rfc4648.html#section-4)、[WebP 压缩设计](https://developers.google.com/speed/webp/docs/compression)、[Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)。
