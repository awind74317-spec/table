# 同桌 · Claude × Codex × GPT

同桌只做唯讀討論：Codex、Claude 可閱讀本地專案，把查到的事實與想法帶給 GPT，一起討論、逐案投票，由主席整理結論。需要實作時，把結論複製到 Codex／Claude 桌面版，另行開工。

## 部署前必讀：GPT 接力的先決條件

**只克隆專案、啟動同桌並登入 ChatGPT，不足以讓 GPT 的回覆回到同桌。** 目前 GPT 接力還需要：

- 可使用的 [WebCodex](https://github.com/yyjeqhc/webcodex) 服務與 ChatGPT 的 WebMCP 連線。
- 在執行同桌的那台電腦設定並連線 WebCodex Runner（執行端），將本專案的 `scripts/webmcp-bridge.mjs` 設為名稱 `roundtable` 的工具提供者。該橋接程式連接本機 `127.0.0.1:17880`；同桌的連接埠若變更，橋接設定也必須一致。
- GPT 使用一般 Chat，能呼叫此 Runner 的 `roundtable` 工具，並通過必要的工具授權。各席登入後仍須確認任務領取及回覆確實返回同桌。

WebCodex 的服務、配對、Runner 及工具提供者不會隨本專案自動安裝或設定。安裝與配對方式請參考 [WebCodex 部署文件](https://github.com/yyjeqhc/webcodex/blob/main/docs/DEPLOYMENT.md)；本專案目前沒有一鍵完成這些設定的流程。若缺少上述條件，GPT 可能可開啟對話或收到訊息，但無法完成同桌接力。

每台電腦都必須使用經確認屬於該機器的 Runner，不可憑「已連線」或沿用其他電腦的 Runner ID 判定為本機。不要把登入資料、配對碼或其他電腦的私人設定放入 Git。**目前程式尚未自動驗證 Runner 的機器身分**；無法確認時，請勿送出含配對碼的工具呼叫。只使用 Codex／Claude 席位時，不需要這套 GPT 接力設定。

## 新電腦安裝（Windows 10／11）

1. 安裝 Node.js 22 以上版本及 Git；如需 Claude／Codex 席位，另安裝相應 CLI 並在本機登入。
2. 執行 `git clone https://github.com/awind74317-spec/table.git`，進入 `table` 資料夾。
3. 雙擊 `open-roundtable.cmd`，或開啟終端執行 `npm start`，用瀏覽器前往 http://127.0.0.1:17880 。
4. 如需 GPT 席位，先完成上方 WebCodex 前提條件，並在專用 ChatGPT 瀏覽器登入；確認 Runner 屬於本機，且 `roundtable` 工具可用後，再測試訊息與回覆的完整往返。
5. 此版本只搬移程式；原機登入、Tailscale 位址、對話歷史與專案資料都不會同步。

## 開啟與使用

雙擊 `open-roundtable.cmd`，或執行 `npm start` 後開啟 **http://127.0.0.1:17880**。保留原本的「會議桌／觀點工作台」雙切。

1. 選擇或建立對話，設定各席模型與主席。
2. 若要討論專案，在右側「討論專案 · 唯讀」填入資料夾並按「套用路徑」；一般資料夾即可，不要求 Git。
3. 指定 Codex 或 Claude，例如：「請讀取此專案的入口與主要模組，介紹現況、列出來源路徑，供 GPT 一起討論，不修改檔案。」
4. 再指定 GPT 接續，或用圓桌讓勾選的席位依序回應。共用歷史會包含前席查到的資訊。
5. 主席不投一般票；其餘參與席位逐案投票，平票由主席依證據裁決，未決交使用者決定，最後整理討論結論。

保留對話歷史、搜尋、重新命名、封存、席位開關、模型與推理設定、指定對象、圓桌順序、輪數、停止與複製回覆。施工、變更預覽、套用／捨棄、執行工單與直接啟動桌面施工功能已移除。舊施工紀錄與對話資料仍保存在本機，不自動刪除或套用。

## 唯讀範圍

Codex 討論使用 read-only sandbox；Claude 掛載專案後僅開放 Read、Glob、Grep。聊天續接與舊設定也重新套用唯讀限制。GPT 的專案寫入與測試工具、舊施工 API 均停用。`/advanced` 回到同桌主介面。

唯讀指「不修改討論專案」；同桌仍會保存自己的對話與設定。專案內容經所選席位提供給相應模型服務，請只掛載你有權提供給這些服務的專案。登入與訂閱額度沿用原設定，不切換成 API 計費。

## GPT 與手機

GPT 每席保留獨立 Chat，第一次需在「開啟專用 GPT 瀏覽器」登入；完成上方 WebCodex 設定後才能指定該席接力。專用瀏覽器保持登入，既有對話續接與中斷狀態照實顯示，不自動重送未知結果。

手機遠端存取需在本機自行設定 Tailscale 與 HTTPS 代理；勿沿用其他電腦的私人網址。

本機設定保存在 `adapters/agents.json`，對話保存在 `sessions/`；這兩者不隨 GitHub 移植，首次啟動會建立新設定。

## 上游與授權

改裝自 [ai-us-stock-lab/roundtable](https://github.com/ai-us-stock-lab/roundtable)，基底 commit `ec07e195e802d52a6754a09eac8fda21c70143f7`，保留 [MIT LICENSE](LICENSE)。沿用後端會話、CLI runner、共用歷史、隔離施工與 diff 套用；新增繁中首頁、每席模型選擇與持久化、訂閱檢查、串流、Windows 啟動與聚焦回歸。上游進階會議介面保留在 `/advanced`。

參考過 [ashwaryy/roundtable](https://github.com/ashwaryy/roundtable) 與 [gkorepanov/ccodex](https://github.com/gkorepanov/ccodex)，但前者原生目標為 macOS/Linux，後者也未列 Windows；本版採支援 Windows 的方案。同桌本體使用 Node.js；GPT 接力另需前述 WebCodex 元件。

免擴充傳送方式參考 [CCCC v0.4.44 的 ChatGPT Web Runtime](https://github.com/ChesterRa/cccc/blob/v0.4.44/docs/guide/web-model-runtime.md)：專用瀏覽器控制加既有 MCP。沒有引入 CCCC 的協作系統或額外隧道。

官方串接依據：[Codex 非互動模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex 登入方式](https://learn.chatgpt.com/docs/auth)、[Claude Code 非互動模式](https://code.claude.com/docs/en/headless)、[Claude 訂閱登入](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)。
