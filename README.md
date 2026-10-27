# 同桌 · Claude × Codex × GPT

同桌只做唯讀討論：Codex、Claude 可閱讀本地專案，把查到的事實與想法帶給 GPT，一起討論、逐案投票，由主席整理結論。需要實作時，把結論複製到 Codex／Claude 桌面版，另行開工。

## 新電腦安裝（Windows 10／11）

1. 安裝 Node.js 22 以上版本及 Git；如需 Claude／Codex 席位，另安裝相應 CLI 並在本機登入。
2. 執行 `git clone https://github.com/awind74317-spec/table.git`，進入 `table` 資料夾。
3. 雙擊 `open-roundtable.cmd`，或開啟終端執行 `npm start`，用瀏覽器前往 http://127.0.0.1:17880 。
4. GPT 席位第一次需登入各自的專用 ChatGPT 瀏覽器；若要使用 webmcp 接力討論，請先在這台電腦連線可用的 webmcp Runner／同桌工具。
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

GPT 每席保留獨立 Chat，第一次需在「開啟專用 GPT 瀏覽器」登入；之後直接指定該席送出訊息。專用瀏覽器保持登入，既有對話續接與中斷狀態照實顯示，不自動重送未知結果。

手機遠端存取需在本機自行設定 Tailscale 與 HTTPS 代理；勿沿用其他電腦的私人網址。

本機設定保存在 `adapters/agents.json`，對話保存在 `sessions/`；這兩者不隨 GitHub 移植，首次啟動會建立新設定。

## 上游與授權

改裝自 [ai-us-stock-lab/roundtable](https://github.com/ai-us-stock-lab/roundtable)，基底 commit `ec07e195e802d52a6754a09eac8fda21c70143f7`，保留 [MIT LICENSE](LICENSE)。沿用後端會話、CLI runner、共用歷史、隔離施工與 diff 套用；新增繁中首頁、每席模型選擇與持久化、訂閱檢查、串流、Windows 啟動與聚焦回歸。上游進階會議介面保留在 `/advanced`。

參考過 [ashwaryy/roundtable](https://github.com/ashwaryy/roundtable) 與 [gkorepanov/ccodex](https://github.com/gkorepanov/ccodex)，但前者原生目標為 macOS/Linux，後者也未列 Windows；本版採已支援 Windows、零額外 runtime 依賴的方案。

免擴充傳送方式參考 [CCCC v0.4.44 的 ChatGPT Web Runtime](https://github.com/ChesterRa/cccc/blob/v0.4.44/docs/guide/web-model-runtime.md)：專用瀏覽器控制加既有 MCP。沒有引入 CCCC 的協作系統或額外隧道。

官方串接依據：[Codex 非互動模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex 登入方式](https://learn.chatgpt.com/docs/auth)、[Claude Code 非互動模式](https://code.claude.com/docs/en/headless)、[Claude 訂閱登入](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)。
