# Volley REST Client

在 VSCode 內收發 HTTP request 的 REST client。資料以標準 OpenAPI 3.1 YAML 保存在你指定的資料夾——把資料夾放在 Dropbox 等雲端同步空間，即可跨裝置共用全部 collections、環境變數與回應歷史。

## 功能

- **三欄式介面**：資料夾樹｜Request 編輯｜Response 檢視。放在底部 Panel 時為三欄並列（可拖曳調整寬度）；拖到左右側邊欄等窄版位置時自動改為 Collection / Request / Response 分頁切換。
- **資料夾管理**：巢狀資料夾、拖曳排序與搬移、右鍵選單（新增/改名/複製/刪除）。
- **環境變數**：Base + 多組 sub-environment（可設色）、資料夾層級變數；解析順序為資料夾（近者優先）→ sub-environment → Base。所有欄位（URL、參數、headers、body、auth）都支援 `{{ _.變數 }}` 片段取代，欄位聚焦時即時預覽解析結果、未定義變數以警告色標示。
- **發送請求**：GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD；query/path 參數、多種 body（JSON/text/XML/YAML/GraphQL/form-urlencoded/multipart/binary）、Basic/Bearer/API Key 認證、cookie jar 自動收送、重新導向跟隨（302/303 依規範降 GET）、逾時與取消。快捷鍵 `Cmd/Ctrl+Enter` 送出。
- **回應狀態暫存（history）**：每個 request 保留最近 N 筆回應（預設 20，可調），存於資料夾內、跨裝置同步、重開 VSCode 仍在。
- **匯入**：OpenAPI 3.x、剪貼簿 curl 指令、Insomnia v5 YAML / v4 JSON 匯出檔。
- **匯出**：乾淨 OpenAPI（去除擴充欄位）、request 複製為 curl、Insomnia v5 YAML（通過該格式的官方 JSON Schema 驗證）。

## 使用方式

1. 安裝後開啟底部 Panel 的「REST Client」（或指令 `Volley: Open`）。
2. **設定同步資料夾**（建議）：在設定中將 `volley.dataFolder` 指向雲端同步資料夾，例如 `~/Dropbox/volley-data`。未設定時資料存於延伸模組本機空間，不跨裝置。
3. 建立 collection → 新增 request → 填 URL（可用 `{{ _.base_url }}/path`）→ Send。
4. 環境變數：側欄環境下拉旁的 ⚙ 開啟管理畫面；資料夾右鍵可編輯資料夾層級變數。
5. 匯入匯出：指令面板搜尋「Volley:」。

### 指令一覽

| 指令                                            | 說明                     |
| ----------------------------------------------- | ------------------------ |
| `Volley: Open`                                  | 開啟主畫面               |
| `Volley: New Collection`                        | 建立 collection          |
| `Volley: Import OpenAPI 3.x`                    | 匯入 OpenAPI 文件        |
| `Volley: Import curl from Clipboard`            | 從剪貼簿匯入 curl 指令   |
| `Volley: Import Insomnia (v5 YAML / v4 JSON)`   | 匯入 Insomnia 格式匯出檔 |
| `Volley: Export Clean OpenAPI (strip x-volley)` | 匯出標準 OpenAPI         |
| `Volley: Export Collection as Insomnia v5 YAML` | 匯出成 Insomnia 格式     |
| `Volley: Reveal Data Folder`                    | 開啟資料夾               |
| `Volley: Reload from Disk`                      | 從磁碟重新載入           |

### 設定項

| 設定                          | 預設   | 說明                                              |
| ----------------------------- | ------ | ------------------------------------------------- |
| `volley.dataFolder`           | （空） | 資料保存資料夾，支援 `~/`；空值用本機延伸模組空間 |
| `volley.requestTimeoutMs`     | 30000  | 請求逾時                                          |
| `volley.followRedirects`      | true   | request 設 global 時是否跟隨導向                  |
| `volley.maxRedirects`         | 10     | 導向次數上限                                      |
| `volley.responseHistoryLimit` | 20     | 每個 request 保留回應筆數                         |
| `volley.maxStoredBodyBytes`   | 262144 | 歷史保存的 body 上限（超過截斷）                  |

## 保存格式與位置

```
<dataFolder>/
├── .volley.json                              # 格式版本標記
├── collections/<名稱>-<id>.openapi.yaml      # 每個 collection 一個標準 OpenAPI 3.1 檔
└── state/
    ├── <collectionId>.ui.json                # UI 狀態（作用中環境、選取、展開）
    └── responses/<collectionId>/<requestId>.json   # 回應歷史
```

collection 檔是**合法的 OpenAPI 3.1 文件**：能投影的 request 放在 `paths` 中（任何 OpenAPI 工具可直接讀），OpenAPI 表達不了的資訊（原始 URL 含變數、資料夾結構、環境、認證、cookie jar 等）放在 `x-volley` 擴充欄位。同一 path+method 的多筆 request 或無法投影的 URL 完整保存於 `x-volley.extraRequests`。可直接手改 YAML，UI 會即時反映；多裝置同時編輯採最後寫入者優先，偵測到 Dropbox 衝突副本會顯示警告。

## 專案結構

```
src/
├── extension.ts               # 啟動、指令註冊
├── views/clientViewProvider.ts # WebviewView、訊息分派、請求執行
├── shared/protocol.ts         # extension ⇄ webview 訊息型別
├── core/                      # 純邏輯層（不依賴 vscode，可單元測試）
│   ├── model/                 # 資料模型與 id 產生
│   ├── formats/               # openapiStore（原生保存）、openapiImport、curl 雙向、insomniaV5/V4、urlPath
│   ├── vars/                  # {{ _.x }} 插值、環境三層合併
│   └── http/                  # fetch 發送、cookie jar、request 組裝
├── storage/                   # 資料夾解析、collection 檔（debounce/原子寫/watch）、狀態檔
└── webview/                   # 原生 TS/DOM UI（三欄/tab 響應式、樹、編輯器、回應檢視）
```

## 限制（v1）

- 認證：Basic / Bearer / API Key 可執行；OAuth2、Digest、NTLM 等類型的欄位會完整保存與匯入匯出，但送出請求時不執行（會提示）。
- Insomnia 格式的 `{% ... %}` template tag（Response、Faker、Prompt 等）不解析，送出時原樣保留並在 Console 提示。
- 資料夾層級 headers/auth、per-request settings、Cookie Jar 管理介面留待後續版本（資料不遺失）。
- gRPC / WebSocket / Socket.IO request 匯入時略過。
- 多裝置同時編輯同一 collection 為最後寫入者優先，衝突視窗極小但存在。

## 開發

```bash
npm install
npm run build          # typecheck + esbuild（extension 與 webview）
./scripts/test-all.sh  # lint + build + 單元測試 + 整合測試（全功能回歸）
npm run package:vsix   # 打包 .vsix
```

在 Dropbox 下開發請先執行 `./scripts/dropbox-ignore.sh` 將 `node_modules/`、`out/`、`.vscode-test/` 標記為不同步。

設計決策與已知取捨見專案內 `docs/NOTES.md`。

## 授權

Apache-2.0
