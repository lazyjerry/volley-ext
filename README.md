# Volley REST Client

在 VSCode 內收發 HTTP request 的 REST client。資料以標準 OpenAPI 3.1 YAML 保存在你指定的資料夾——把資料夾放在 Dropbox 等雲端同步空間，即可跨裝置共用全部 collections、環境變數與回應歷史。

## 功能

- **三欄式介面**：資料夾樹｜Request 編輯｜Response 檢視。放在底部 Panel 時為三欄並列（可拖曳調整寬度）；拖到左右側邊欄等窄版位置時自動改為 Collection / Request / Response 分頁切換。
- **共用／私人雙資料夾**：`volley.dataFolder`（共用，建議指向雲端同步空間）與 `volley.privateDataFolder`（私人，適合放不同步的個人 collection）完全隔離、各自存檔；兩邊的 collections 同列在選擇器中，以「共用」「私人」分組顯示，各自可新增。
- **可搜尋選擇器**：collection 與環境選擇器均可輸入文字即時過濾；輸入的名稱不存在時，底部出現「＋ 新增」選項，點擊即以該名稱建立 collection（選共用或私人）或環境。
- **資料夾管理**：巢狀資料夾、拖曳排序與搬移（顯示插入位置指示線，停在資料夾上會自動展開）、工具列 🗀 新增資料夾、右鍵新增 request／改名/複製/刪除；刪除非空資料夾時可選擇連同內容刪除，或只刪資料夾把內容移到上一層。
- **環境變數**：Base + 多組 sub-environment（可設色）、資料夾層級變數；解析順序為資料夾（近者優先）→ sub-environment → Base。所有欄位（URL、參數、headers、body、auth）都支援 `{{ _.變數 }}` 片段取代，欄位聚焦時即時預覽解析結果、未定義變數以警告色標示。
- **發送請求**：GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD；query/path 參數、多種 body（JSON/text/XML/YAML/GraphQL/form-urlencoded/multipart/binary）、Basic/Bearer/API Key 認證、cookie jar 自動收送、重新導向跟隨（302/303 依規範降 GET）、逾時與取消。快捷鍵 `Cmd/Ctrl+Enter` 送出。
- **回應狀態暫存（history）**：每個 request 保留最近 N 筆回應（預設 20，可調），存於資料夾內、跨裝置同步、重開 VSCode 仍在。
- **匯入**：OpenAPI 3.x、剪貼簿 curl 指令、Insomnia v5 YAML / v4 JSON 匯出檔；也可輸入網址直接下載匯入（自動辨識格式）。
- **匯出**：乾淨 OpenAPI（去除擴充欄位）、request 複製為 curl、Insomnia v5 YAML（通過該格式的官方 JSON Schema 驗證）。

## 使用方式

1. 安裝後開啟底部 Panel 的「Volleeeey」（或指令 `Volley: Open`）。
2. **設定同步資料夾**（建議）：在設定中將 `volley.dataFolder` 指向雲端同步資料夾，例如 `~/Dropbox/volley-data`。未設定時資料存於延伸模組本機空間，不跨裝置。另可設定 `volley.privateDataFolder` 作為第二個（不同步的）私人資料夾，兩者的 collections 在選擇器中分組並存。
3. 建立 collection → 新增 request → 填 URL（可用 `{{ _.base_url }}/path`）→ Send。
4. 環境變數：側欄環境選擇器可直接搜尋與新增環境；旁邊的 ⚙ 開啟管理畫面（有變動時關閉鈕顯示儲存圖示、無變動顯示 ✕）；資料夾右鍵可編輯資料夾層級變數。
5. 匯入匯出：指令面板搜尋「Volley:」。

### 範例 Collection

[samples/volley-sample.insomnia.yaml](https://github.com/lazyjerry/volley-ext/blob/main/samples/volley-sample.insomnia.yaml) 是可直接匯入的範例（Insomnia v5 YAML，34 個 request，全部使用免金鑰的公開 API）。

匯入方式：側欄「更多…」→「匯入 Insomnia…」選取檔案，或用「從網址匯入…」貼上這個網址直接下載匯入：

```
https://raw.githubusercontent.com/lazyjerry/volley-ext/main/samples/volley-sample.insomnia.yaml
```

> 手動下載檔案請用上面的 raw 網址（`wget https://raw.githubusercontent.com/...`）。對 GitHub 網頁網址（含 `/blob/`）執行 wget 或另存新檔，會下載到 HTML 網頁而非 YAML，匯入時會報格式錯誤。

涵蓋情境：GET/POST/PUT/PATCH/DELETE/HEAD、查詢參數（含停用）、JSON / form-urlencoded / multipart / 純文字 / XML / GraphQL body、Basic / Bearer / API Key 認證、轉址（跟隨與不跟隨）、延遲、gzip、cookie 存取、環境變數（含巢狀物件與 sub-environment 切換）、資料夾層級變數與 headers 繼承、巢狀資料夾、`renderRequestBody` 與 `cookies.send` 等 request 設定。

使用的遠端服務（皆為公開測試 API）：

| 服務 | 用途 |
| ---- | ---- |
| [httpbingo.org](https://httpbingo.org) | HTTP 測試（方法、認證、轉址、cookie、延遲、gzip） |
| [postman-echo.com](https://postman-echo.com) | sub-environment 切換示範（與 base_url 互換） |
| [jsonplaceholder.typicode.com](https://jsonplaceholder.typicode.com) | REST CRUD 假資料 |
| [countries.trevorblades.com](https://countries.trevorblades.com) | GraphQL 查詢 |
| [open-meteo.com](https://open-meteo.com) | 天氣資料 |
| [api.zippopotam.us](https://api.zippopotam.us) | 郵遞區號查詢 |
| [api.github.com](https://docs.github.com/rest) | 需自訂 header 的真實 API（未登入額度 60 次/小時） |

範例由 `scripts/generate-sample-collection.js` 產生（會驗證官方 schema 與 round-trip 匯入），修改後重新執行即可更新。

### 指令一覽

| 指令                                            | 說明                     |
| ----------------------------------------------- | ------------------------ |
| `Volley: Open`                                  | 開啟主畫面               |
| `Volley: New Collection`                        | 建立 collection          |
| `Volley: Import OpenAPI 3.x`                    | 匯入 OpenAPI 文件        |
| `Volley: Import curl from Clipboard`            | 從剪貼簿匯入 curl 指令   |
| `Volley: Import Insomnia (v5 YAML / v4 JSON)`   | 匯入 Insomnia 格式匯出檔 |
| `Volley: Import from URL`                       | 從網址下載並匯入（自動辨識格式） |
| `Volley: Export Clean OpenAPI (strip x-volley)` | 匯出標準 OpenAPI         |
| `Volley: Export Collection as Insomnia v5 YAML` | 匯出成 Insomnia 格式     |
| `Volley: Choose Data Folder`                    | 以資料夾選擇器設定共用／私人資料夾 |
| `Volley: Reveal Data Folder`                    | 開啟資料夾（詢問共用／私人） |
| `Volley: Reload from Disk`                      | 從磁碟重新載入           |

### 設定項

| 設定                          | 預設   | 說明                                              |
| ----------------------------- | ------ | ------------------------------------------------- |
| `volley.dataFolder`           | （空） | 共用資料夾，支援 `~/`；空值用本機延伸模組空間     |
| `volley.privateDataFolder`    | （空） | 私人資料夾（與共用完全隔離）；空值用延伸模組空間的 private 子資料夾 |
| `volley.requestTimeoutMs`     | 30000  | 請求逾時                                          |
| `volley.followRedirects`      | true   | request 設 global 時是否跟隨導向                  |
| `volley.maxRedirects`         | 10     | 導向次數上限                                      |
| `volley.responseHistoryLimit` | 20     | 每個 request 保留回應筆數                         |
| `volley.maxStoredBodyBytes`   | 262144 | 歷史保存的 body 上限（超過截斷）                  |

## 保存格式與位置

```
<dataFolder>/                                 # 共用與私人資料夾各自一份相同結構
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
