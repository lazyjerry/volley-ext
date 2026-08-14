#!/usr/bin/env node
// 產生範例 collection（Insomnia v5 YAML，可由「更多… → 匯入 Insomnia…」匯入）。
// 用專案自身的 exportInsomniaV5 產出，並以官方 schema + round-trip 匯入驗證。
// 執行前需先 npm run build:tests（依賴 out/src 下的 tsc 產物）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { genId } = require(path.join(root, 'out/src/core/model/ids.js'));
const { defaultSettings, normalizeSortKeys } = require(path.join(root, 'out/src/core/model/types.js'));
const { exportInsomniaV5, importInsomniaV5 } = require(path.join(root, 'out/src/core/formats/insomniaV5.js'));

function req(name, method, url, extra = {}) {
  return {
    kind: 'request',
    id: genId('req'),
    name,
    sortKey: 0,
    method,
    url,
    parameters: [],
    pathParameters: [],
    headers: [],
    body: {},
    authentication: {},
    settings: defaultSettings(),
    ...extra,
  };
}

function folder(name, children, extra = {}) {
  return { kind: 'folder', id: genId('fld'), name, sortKey: 0, children, ...extra };
}

function jsonBody(obj) {
  return { mimeType: 'application/json', text: JSON.stringify(obj, null, 2) };
}

const now = Date.now();

const children = [
  req('Ping（根層級 request）', 'GET', '{{ _.httpbin_url }}/uuid', {
    description: 'request 也可以放在根層級，不一定要在資料夾內。',
  }),

  folder('01 基本方法', [
    req('GET + 查詢參數', 'GET', '{{ _.base_url }}/get', {
      description: 'Params 分頁維護查詢參數；停用的參數不會送出。',
      parameters: [
        { name: 'q', value: 'volley', description: '關鍵字' },
        { name: 'page', value: '1' },
        { name: 'debug', value: 'true', disabled: true, description: '停用中，不會送出' },
      ],
    }),
    req('POST JSON（含物件變數）', 'POST', '{{ _.base_url }}/post', {
      description: '{{ _.profile }} 是物件變數，插值時會序列化為 JSON。',
      body: {
        mimeType: 'application/json',
        text: '{\n  "title": "volley demo",\n  "profile": {{ _.profile }}\n}',
      },
    }),
    req('PUT', 'PUT', '{{ _.base_url }}/put', { body: jsonBody({ id: 1, title: 'updated' }) }),
    req('PATCH', 'PATCH', '{{ _.base_url }}/patch', { body: jsonBody({ title: 'patched' }) }),
    req('DELETE', 'DELETE', '{{ _.base_url }}/delete'),
    req('HEAD（只看 headers）', 'HEAD', '{{ _.base_url }}/status/200'),
  ], { description: '這個資料夾的 request 都用 {{ _.base_url }}，切換 sub-environment 可整批改打 Postman Echo。' }),

  folder('02 認證', [
    req('Basic Auth', 'GET', '{{ _.httpbin_url }}/basic-auth/{{ _.cred.user }}/{{ _.cred.pass }}', {
      description: '帳密取自環境變數的巢狀物件 cred。',
      authentication: { type: 'basic', username: '{{ _.cred.user }}', password: '{{ _.cred.pass }}' },
    }),
    req('Bearer Token', 'GET', '{{ _.httpbin_url }}/bearer', {
      authentication: { type: 'bearer', token: '{{ _.token }}' },
    }),
    req('API Key（自訂 header）', 'GET', '{{ _.httpbin_url }}/headers', {
      description: '回應會 echo 收到的 X-Api-Key。',
      authentication: { type: 'apikey', key: 'X-Api-Key', value: '{{ _.token }}', addTo: 'header' },
    }),
    req('認證已停用', 'GET', '{{ _.httpbin_url }}/headers', {
      description: 'authentication.disabled = true，不會附加 Authorization。',
      authentication: { type: 'bearer', token: '{{ _.token }}', disabled: true },
    }),
  ]),

  folder('03 Body 形式', [
    req('form-urlencoded', 'POST', '{{ _.base_url }}/post', {
      body: {
        mimeType: 'application/x-www-form-urlencoded',
        params: [
          { name: 'name', value: 'Volley' },
          { name: 'lang', value: 'zh-TW' },
          { name: 'skip', value: 'me', disabled: true },
        ],
      },
    }),
    req('multipart/form-data', 'POST', '{{ _.base_url }}/post', {
      body: {
        mimeType: 'multipart/form-data',
        params: [
          { name: 'field1', value: 'hello', type: 'text' },
          { name: 'token', value: '{{ _.token }}', type: 'text' },
        ],
      },
    }),
    req('純文字 body', 'POST', '{{ _.base_url }}/post', {
      body: { mimeType: 'text/plain', text: 'hello from volley' },
    }),
    req('XML body', 'POST', '{{ _.base_url }}/post', {
      headers: [{ name: 'Content-Type', value: 'application/xml' }],
      body: { mimeType: 'application/xml', text: '<note><to>Volley</to><body>示範 XML</body></note>' },
    }),
    req('GraphQL（Countries API）', 'POST', 'https://countries.trevorblades.com/', {
      description: '公開 GraphQL API，查台灣的國名、首都與 emoji。',
      body: jsonBody({ query: '{ country(code: "TW") { name capital emoji currency } }' }),
    }),
    req('不插值 body（renderRequestBody=false）', 'POST', '{{ _.base_url }}/post', {
      description: 'body 中的 {{ raw_text }} 會原樣送出，不做變數插值。',
      body: jsonBody({ template: '{{ raw_text }}' }),
      settings: { ...defaultSettings(), renderRequestBody: false },
    }),
  ]),

  folder('04 回應與轉址', [
    req('跟隨轉址（3 次）', 'GET', '{{ _.httpbin_url }}/redirect/3', {
      description: '回應面板會列出 redirect chain。',
    }),
    req('不跟隨轉址', 'GET', '{{ _.httpbin_url }}/redirect-to', {
      description: 'followRedirects = off，會停在 302。',
      parameters: [{ name: 'url', value: 'https://example.com/' }],
      settings: { ...defaultSettings(), followRedirects: 'off' },
    }),
    req('延遲 2 秒', 'GET', '{{ _.httpbin_url }}/delay/2'),
    req('JSON 回應', 'GET', '{{ _.httpbin_url }}/json'),
    req('XML 回應', 'GET', '{{ _.httpbin_url }}/xml'),
    req('HTML 回應', 'GET', '{{ _.httpbin_url }}/html'),
    req('404', 'GET', '{{ _.httpbin_url }}/status/404'),
    req('gzip 壓縮回應', 'GET', '{{ _.httpbin_url }}/gzip'),
  ]),

  folder('05 Cookie', [
    req('設定 cookie', 'GET', '{{ _.httpbin_url }}/cookies/set', {
      description: '回應的 Set-Cookie 會存進 cookie jar。',
      parameters: [
        { name: 'demo', value: 'volley' },
        { name: 'flavor', value: 'lime' },
      ],
    }),
    req('讀取 cookie', 'GET', '{{ _.httpbin_url }}/cookies', {
      description: '先執行「設定 cookie」，這裡會 echo jar 內送出的 cookie。',
    }),
    req('不送 cookie', 'GET', '{{ _.httpbin_url }}/cookies', {
      description: 'settings.cookies.send = false，jar 有 cookie 也不送。',
      settings: { ...defaultSettings(), cookies: { send: false, store: true } },
    }),
  ]),

  folder('06 真實 API 與資料夾繼承', [
    req('JSONPlaceholder 清單', 'GET', '{{ _.jsonph_url }}/{{ _.resource }}', {
      description: 'resource 來自資料夾變數；X-Demo-Folder header 由資料夾層級附加。',
      parameters: [{ name: '_limit', value: '5' }],
    }),
    req('JSONPlaceholder 單筆', 'GET', '{{ _.jsonph_url }}/{{ _.resource }}/1'),
    req('JSONPlaceholder 建立', 'POST', '{{ _.jsonph_url }}/{{ _.resource }}', {
      body: jsonBody({ title: 'volley', body: '從範例 collection 送出', userId: 1 }),
    }),
    folder('巢狀子資料夾：其他公開 API', [
      req('Zippopotam：郵遞區號查詢', 'GET', 'https://api.zippopotam.us/us/90210', {
        description: '公開郵遞區號 API，免金鑰。',
      }),
      req('Open-Meteo：台北天氣', 'GET', 'https://api.open-meteo.com/v1/forecast', {
        parameters: [
          { name: 'latitude', value: '25.03' },
          { name: 'longitude', value: '121.56' },
          { name: 'current_weather', value: 'true' },
        ],
      }),
      req('GitHub：vscode repo', 'GET', 'https://api.github.com/repos/microsoft/vscode', {
        description: 'GitHub API 要求 User-Agent header（未登入額度 60 次/小時）。',
        headers: [
          { name: 'User-Agent', value: 'volley-sample' },
          { name: 'Accept', value: 'application/vnd.github+json' },
        ],
      }),
    ]),
  ], {
    environment: { resource: 'posts' },
    headers: [{ name: 'X-Demo-Folder', value: 'volley' }],
    description: '示範資料夾層級的變數（resource）與 headers 繼承，以及巢狀資料夾。',
  }),
];

const collection = {
  id: genId('wrk'),
  name: 'Volley 範例 Collection',
  description: '涵蓋方法、認證、body 形式、轉址、cookie、環境變數與資料夾繼承的公開 API 範例。',
  created: now,
  modified: now,
  servers: [],
  children,
  environments: {
    base: {
      id: genId('env'),
      name: 'Base Environment',
      data: {
        base_url: 'https://httpbingo.org',
        httpbin_url: 'https://httpbingo.org',
        jsonph_url: 'https://jsonplaceholder.typicode.com',
        token: 'volley-demo-token',
        cred: { user: 'volley', pass: 's3cret' },
        profile: { name: 'Volley', tags: ['rest', 'demo'] },
      },
    },
    subEnvironments: [
      {
        id: genId('env'),
        name: 'httpbingo.org（同 Base）',
        color: '#4f9cf9',
        data: { base_url: 'https://httpbingo.org' },
      },
      {
        id: genId('env'),
        name: 'Postman Echo',
        color: '#39b54a',
        data: { base_url: 'https://postman-echo.com' },
      },
    ],
  },
  cookieJar: {
    id: genId('jar'),
    name: 'Default Jar',
    cookies: [
      {
        id: genId('jar'),
        key: 'seeded',
        value: 'from-import',
        domain: 'httpbingo.org',
        path: '/',
        secure: false,
        httpOnly: false,
        hostOnly: false,
        expires: null,
      },
    ],
  },
};

normalizeSortKeys(collection.children);

const yamlText = exportInsomniaV5(collection);

// 驗證 1：官方 Insomnia v5 JSON Schema
const Ajv2020 = require('ajv/dist/2020');
const YAML = require('yaml');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/insomnia.schema.5.1.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);
if (!validate(YAML.parse(yamlText))) {
  console.error('schema 驗證失敗：', JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}

// 驗證 2：round-trip 匯入
const imported = importInsomniaV5(yamlText);
const count = (nodes) => nodes.reduce((n, c) => n + (c.kind === 'folder' ? count(c.children) : 1), 0);
if (count(imported.children) !== count(collection.children)) {
  console.error('round-trip 匯入的 request 數量不符');
  process.exit(1);
}
if (imported.environments.subEnvironments.length !== 2) {
  console.error('round-trip 匯入的 sub-environment 數量不符');
  process.exit(1);
}

const outFile = path.join(root, 'samples', 'volley-sample.insomnia.yaml');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, yamlText);
console.log(`OK：schema 驗證與 round-trip 通過，共 ${count(collection.children)} 個 request`);
console.log(outFile);
