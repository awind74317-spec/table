# Changelog / 更新日志

This file is for Roundtable users. For the detailed internal development stream, see [`docs/dev-log.md`](docs/dev-log.md). / 本文件面向 Roundtable 使用者；详细开发流水见 [`docs/dev-log.md`](docs/dev-log.md)。

Before 1.0, `0.x.y` uses `y` for bug-fix-only releases, while `x` releases may include breaking changes. / 1.0 之前，`0.x.y` 中的 `y` 只修 bug，`x` 版本可能包含破坏性变更。

## v0.4.2 - 2026-07-31

### Fixed / 修复

- Windows clipboard verification now treats `CRLF`/`LF` line-ending conversion as content-preserving while still rejecting truncation, insertion, replacement, and encoding damage. The confirmed package's UTF-8 byte count and SHA-256 are recomputed before any write, and mismatch diagnostics expose structure only—never clipboard text, credentials, or private code. / Windows 剪贴板验证现在将 `CRLF`/`LF` 换行转换视为内容保真，同时仍会拒绝截断、插入、替换和编码损坏。写入前会重新计算已确认执行包的 UTF-8 字节数与 SHA-256；不匹配诊断只报结构信息，绝不回显剪贴板正文、凭据或私有代码。
- The cross-instance resume test now waits for round 2 to reach its completed paused state before reading round-2 prompts, eliminating the Windows/Node 20 timing flake without changing production orchestration. / 跨实例恢复测试现在会等第 2 轮真正完成并进入暂停状态后再读取第 2 轮提示词，消除 Windows/Node 20 的时序抖动，不改动生产编排逻辑。

### Upgrade note / 升级提示

- Restart Roundtable after updating. No configuration changes are required. / 更新后请重启 Roundtable；无需修改配置。

## v0.4.1 - 2026-07-26

### Fixed / 修复

- Upload filename sanitization is now platform-independent. Windows-style traversal names such as `..\..\hack.txt` are reduced to a safe basename on Linux as well as Windows, and resolved attachment paths must remain inside the session `uploads/` directory. The full Windows/Ubuntu × Node 20/22 CI matrix now passes. / 上传文件名清洗现在与运行平台无关。Windows 风格的路径穿越名（如 `..\..\hack.txt`）在 Linux 和 Windows 上都会被收敛为安全的纯文件名；解析后的附件路径还必须留在会话的 `uploads/` 目录内。Windows/Ubuntu × Node 20/22 的完整 CI 矩阵现已全部通过。

## v0.4.0 - 2026-07-25

### Added / 新增

- **Meeting templates with capability authorization (v1).** Pick one of five explicit templates when creating a workbench or meeting (basic strategy — the default, product/business strategy review, evidence research, technical review, execution workbench). Each template assembles a minimal, versioned capability set: a strategy-core discipline layer loads everywhere; framework/persona/web-research capabilities appear to models only as Roundtable-curated one-line metadata until you approve them — approval is session-only, and saving a capability into the template permanently is a separate, versioned confirmation. The system never guesses the template from your topic text. / **会议模板与能力授权装配（v1）**：建台/建会时从五个显式模板中选择（基础策略——默认、产品/商业策略审查、证据研究、技术评审、执行型工作台）。每个模板装配最小的版本化能力集：strategy-core 纪律层全场默认；框架/人物视角/联网检索类能力在你批准前只以 Roundtable 策划的一行安全元数据出现——批准仅本场有效，永久写回模板是另一次独立的版本化确认。系统绝不按议题文本猜模板。

- **File and image attachments in the workbench.** Click 📎 to attach text files or images to a message. Text files are inlined into the prompt as clearly-framed material (30K chars per file, truncation always disclosed); images reach engines with real image support (Codex `-i`), while engines without it get an honest "cannot view images" note instead of pretending. Uploads live inside the session folder; 20MB per file. / **工作台支持上传文件与图片**：点 📎 给消息附带文本文件或图片。文本文件内联为明确框定的材料（单文件 3 万字符，截断必明示）；图片送达真正支持图片的引擎（Codex `-i`），不支持的引擎会收到如实的「无法查看图片」标注而不是装看过。附件存在会话目录内，单文件上限 20MB。

- **Chat ↔ meeting handoff (v1).** Send any chat message to an open meeting explicitly, choosing its type (supplement material / correct a fact / answer a question / change goal or constraint). Updates queue during a round, and after your round-boundary approval enter both debaters' next briefs identically. Approving a fact or goal change marks the existing verdict "possibly stale" until you explicitly re-review, which produces a new verdict version with the old one archived. Nothing syncs automatically, and pasted material can never trigger tools, permissions, or capability loading — control marker lookalikes in user text are structurally defused. / **聊天 ↔ 会议交接（v1）**：任何聊天消息都可显式发送到进行中的会议，并选定类型（补充材料/更正事实/回答提问/改目标约束）。更新在轮中只排队，经你在轮末批准后一字不差地进入下一轮双方简报。批准事实/目标变更会把已有裁决标记为「可能过期」，直到你显式重审——重审产出新裁决版本，旧版归档。没有任何自动同步；粘贴的材料永远不能触发工具、权限或能力装配——用户文本中的控制标记会在结构层拆除。

- **Desktop execution handoff, clipboard-only (v1).** A workbench-side panel copies a discussion's conclusion to the clipboard byte-for-byte — write-then-readback verified by exact string, UTF-8 byte count and SHA-256 — so you can paste it into your context-rich Claude/Codex desktop app to actually run it. Roundtable assembles and copies; it never executes for you, never drives your desktop, and the copied natural-language text is never re-interpreted as a control protocol. The conclusion is produced on demand: nothing runs until you click "Summarize & preview", and you choose which participating model distills the whole discussion into one clean, paste-ready task. / **桌面执行交接，仅剪贴板（v1）**：工作台侧栏面板把一场讨论的结论一字不差地复制到剪贴板——写入后立即回读，逐字、UTF-8 字节数与 SHA-256 三重校验——供你粘到上下文更全的 Claude/Codex 桌面版真正执行。Roundtable 只负责装配与复制，绝不替你执行、不控制你的桌面，复制出的自然语言也绝不被当作控制协议解析。结论按需生成：不点「总结并生成预览」就不跑，且你可选择由哪个参与模型把整场讨论提炼成一段可直接粘贴的干净任务。

- **Visual refresh aligned with the OpenWorker design language, plus an in-app theme switch.** New sidebar button cycles auto / light / dark (auto follows your OS). Tokens now match OpenWorker's real palette — cool-gray paper, white panels, cobalt accent with soft fills, paired semantic colors, 14/10px radii, frosted top bars — in both themes. Layout and features unchanged. / **视觉层对齐 OpenWorker 设计语言，并新增应用内主题切换**：侧栏新按钮在 自动/浅色/深色 间循环（自动跟随系统）。配色对齐其真实 token——冷灰纸底、白面板、钴蓝 accent 与软填充、成套语义色、14/10px 圆角、毛玻璃顶栏，明暗两档齐备。布局与功能不变。

- **Meeting view redesigned: opposing tracks + decision rail + bottom control bar.** The cramped three-column arena is now two side-by-side opinion tracks; the scribe/judge outputs, rolling summary, verdict card, pending updates and sideline Q&A live in a collapsible right-hand decision rail (with an unread badge while collapsed — your own messages never count); all meeting actions and the phase indicator moved to a persistent frosted bottom bar. When a debater answers you in sideline Q&A, its track shows a "replying to you" anchor that jumps to the message. Narrow screens stack the tracks and turn the rail into a drawer (Escape closes). / **会议界面重设计：观点对峙双轨 + 决策侧栏 + 底部控制条**。拥挤的三列会场改为左右两条观点轨道；书记/仲裁产出、滚动摘要、裁决卡、待纳入更新与场边追问收进右侧可折叠决策侧栏（收起时有未读徽标——你自己的发言不计）；全部会议操作与阶段指示移入底部常驻毛玻璃控制条。辩手在场边追问回应你时，其轨道会出现「回应你」锚点，点击直达那条消息。窄屏双轨上下堆叠、侧栏变抽屉（Escape 关闭）。

### Changed / 变更

- **Roundtable is now the sole assembler of model context.** Model subprocesses no longer inherit your user-global CLI config: Claude runs with `--setting-sources project --strict-mcp-config` (user-level hooks/skills/plugins/MCP/memories verified gone), Codex with `--ignore-user-config` (config-defined hooks/MCP verified gone). Every call requires an explicit context profile (`scratch` / `readonly-materials` / `trusted-project`) and writes a `context_manifest.json` audit record per call. Known residual: Codex still loads `~/.codex/AGENTS.md` and its skills (no CLI off-switch exists yet — recorded honestly in the manifest). / **Roundtable 现在是模型上下文的唯一装配者。** 模型子进程不再继承你的用户级全局配置：Claude 带 `--setting-sources project --strict-mcp-config`（用户级 hooks/技能/插件/MCP/记忆实测清零），Codex 带 `--ignore-user-config`（config 定义的 hooks/MCP 实测清零）。每次调用必须携带显式上下文 profile（`scratch`/`readonly-materials`/`trusted-project`），并落一份 `context_manifest.json` 审计记录。已知残余：Codex 仍会装载 `~/.codex/AGENTS.md` 与其 skills（该版本 CLI 无关闭开关——manifest 中如实标注）。
- Upgrade note: if you relied on user-global skills/memories auto-triggering inside Roundtable sessions, that no longer happens — put such content into the meeting materials or the mounted project instead. / 升级须知：若你依赖用户级技能/记忆在 Roundtable 会话里自动生效，现在不会了——请把这类内容放进会议材料或挂载的项目目录。

### Fixed / 修复

- Codex failed instantly (`exit:1`) in meetings with a mounted folder that isn't a git repository — its trusted-directory check refused to start. Roundtable now always passes `--skip-git-repo-check` (reads are still sandboxed). Also: resuming a meeting used to silently erase its mounted-folder setting, and round buttons are now disabled while a round is running instead of erroring when clicked. / 修复挂载了非 git 仓库目录的会议中 Codex 秒失败（`exit:1`，受信目录检查拒绝启动）——现在始终传 `--skip-git-repo-check`（读取仍受沙箱限制）。另修复：恢复会议会静默抹掉挂载目录设置；跑轮期间「下一轮」等按钮现在直接禁用，而不是点了才报错。
- "Auto-run" silently proceeded to judging after the rounds finished, spending a judge call and issuing a verdict nobody asked for. Auto-run now does exactly what it says — runs the rounds, then pauses and tells you your options (go to verdict / add rounds / interject). The verdict only ever happens when you hit "Go to verdict". / 修复「自动跑完」在轮次结束后擅自进入裁决——既烧一次仲裁额度，也产出了没人要求的裁决。现在自动跑完只跑轮次，跑完停下并明示下一步选项（进入裁决/加轮/插话）；裁决只在你点「进入裁决」时发生。
- Meeting content never reached the source chat unless a verdict card was produced: coming back mid-meeting, the conversation only had "meeting started" and the models knew nothing about what was discussed. Meeting content now flows back at three levels, none of which waits for a verdict: each debater statement the moment it completes, each round's scribe summary, and the verdict card — leaving mid-round loses nothing. All appear as expandable cards on the source workbench timeline and enter the conversation context. / 修复会议内容不回流对话：此前只有裁决卡会自动落回，没走到裁决就回到对话时，时间线里只有「会议已开始」，对话里的模型对会议内容一无所知。现在回流分三层且都不等裁决：辩手每段发言完成即落回、每轮书记小结落回、裁决卡落回——半轮离会也不丢内容。全部以可展开卡片进入来源工作台时间线并进对话上下文。
- The Stop button did nothing during ordinary chat (including broadcasts): only relay and build calls were abortable, so a slow engine kept you waiting minutes. Stop now kills the in-flight call and skips remaining recipients for chat and conflict-digest too. / 修复普通聊天（含广播）点「停止」无效：此前只有互聊和动手可中止，慢引擎一跑就是几分钟只能干等。现在聊天与冲突分析同样立即掐断正在跑的调用，并跳过尚未调用的收件人。
- "Let them talk" ignored whatever you had typed in the message box: the relay ran on prior history only and your text was silently left behind. Your text is now posted first and becomes the topic every speaker sees. / 修复「让他们讨论」丢掉输入框里的话:互聊只用了此前的历史,你写的内容被静静留在框里。现在会先把它作为本场题面发出,每一位发言者都看得到。
- Windows: the folder dialog could open buried behind the browser — the button showed "opening the system dialog…" while nothing seemed to happen. The dialog is now forced always-on-top the moment it appears. / 修复 Windows 下文件夹对话框可能压在浏览器后面打开——按钮一直显示「正在打开系统对话框…」但看不到任何窗口。现在对话框一出现就强制置顶。
- Windows: picking a project folder took two attempts. The folder dialog closed itself after about two seconds while you were still browsing, and the second attempt fell back to the old-style folder tree. It now opens once, comes to the front, and waits for you. / 修复 Windows 下选项目文件夹要选两次：你还在翻目录时对话框会在约两秒后自行关闭，第二次又退回旧式文件夹树。现在只弹一次，自动到最前，并一直等你选完。

## v0.3.1 - 2026-07-21

### Fixed / 修复

- `npm test` failed on Node 20: the old command relied on glob arguments that only Node 22+ supports, so both Node 20 CI jobs errored before any test ran. Tests now run identically on Node 20/22 and Windows/Ubuntu. / 修复 Node 20 下 `npm test` 失败：旧命令依赖 Node 22+ 才支持的 glob 参数，两个 Node 20 的 CI 任务在测试开始前就报错。现在 Node 20/22、Windows/Ubuntu 行为一致。
- `adapters/agents.json` is now your own file instead of a tracked repository file, so editing your agent config no longer collides with updates. A fresh checkout generates it from `adapters/agents.example.json` on first start. / `adapters/agents.json` 改为归你所有的本地文件，不再随仓库跟踪，修改 agent 配置不会再与更新冲突；全新检出会在首次启动时从 `adapters/agents.example.json` 生成。

### Added / 新增

- Continuous integration on GitHub Actions: Windows and Ubuntu × Node 20 and 22. / GitHub Actions 持续集成：Windows 与 Ubuntu × Node 20 与 22。
- Compatibility tests that keep sessions created by earlier versions readable. / 兼容性测试，保证早期版本创建的会话继续可读。
- This changelog, a release checklist, and an "Updating" section in the README. / 本更新日志、发布清单，以及 README 的「更新」小节。

### Upgrade notes / 升级须知

- **Restart required? Yes.** The backend changed; stop the running Roundtable process and start it again. / **需要重启吗？需要。** 后端有变更，请停止现有进程后重新启动。
- **Configuration?** Nothing to do. `adapters/agents.json` is yours and updates never overwrite it. / **配置要动吗？** 无需操作。`adapters/agents.json` 归你所有，更新不会覆盖。
- **Old sessions?** Still open, and now covered by compatibility tests. / **老会话？** 仍可打开，并已有兼容测试覆盖。

## v0.3.0 - 2026-07-21

### Added / 新增

- Unified Workbench and Committee: promote a discussion into a meeting, open meeting cards from the timeline, and automatically return verdicts to the source Workbench. / 工作台与委员会统一串联：讨论可升格开会，时间线会议卡可直接打开，裁决会自动回到来源工作台。
- Added a per-file change workflow with isolated proposals, conflict comparison, optional arbiter-assisted merging, deterministic safety gates, and an application audit trail. / 新增逐文件变更流程：隔离提案、冲突对比、可选仲裁融合、确定性安全门与应用审计记录。
- Added in-app Agent configuration and diagnostics, on-demand readiness checks, editable workspace paths, and participant controls. / 新增界面内 Agent 配置与诊断、按需就绪检查、可修改工作区路径和会话成员管理。
- Added template-specific role briefs and an in-form preview so different meeting templates produce meaningfully different debates. / 新增模板专属角色简报与表单预览，让不同会议模板产生实质差异。

### Improved / 改进

- Folder selection now prefers the native system dialog, with a browser fallback, cancellation escape hatch, and clearer recovery for quoted, missing, or file paths. / 目录选择优先使用系统原生对话框，并提供浏览兜底、取消逃生口，以及对带引号、不存在或误选文件路径的明确恢复指引。
- Workbench roles now separate discussion, proposal, arbitration, and delegated decision duties while keeping final file application under user control. / 工作台角色现在区分讨论、提案、仲裁与代决职责，同时文件最终应用权仍归用户。
- Frontend/backend version mismatch detection and no-cache delivery make upgrades and restarts easier to understand. / 新增前后端版本错配提醒与 no-cache 下发，升级后何时需要重启更加清楚。

### Fixed / 修复

- Applying or checking a diff now uses the original patch; redaction remains display-only, preventing placeholders from entering real files. / 应用或检查 diff 改用原始 patch，脱敏版只用于展示，避免占位符写入真实文件。
- Fixed native folder dialogs getting stuck behind the browser by adding foreground ownership and an explicit cancel path. / 修复原生目录对话框藏在浏览器后导致卡死的问题，并补充显式取消路径。

### Upgrade notes / 升级须知

- **Restart required? Yes.** This release changes the backend; stop the running Roundtable process and start it again after updating. / **是否需要重启？需要。** 本版本包含后端变更，更新后请停止现有 Roundtable 进程并重新启动。
- **Configuration changes?** `adapters/agents.json` is now user-owned. A fresh install creates it from `adapters/agents.example.json` on first start; an existing `agents.json` is left in place. / **配置是否要动？** `adapters/agents.json` 现在归用户所有；全新安装首次启动会从 `adapters/agents.example.json` 生成，已有用户的现有文件不受影响。
- **Can old sessions still open? Yes.** Legacy Workbench and Committee archives remain supported and are covered by compatibility tests. / **老会话是否还能打开？能。** 旧工作台与旧会议归档继续兼容，并已有兼容测试覆盖。
