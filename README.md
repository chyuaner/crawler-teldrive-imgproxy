Teldrive ImgProxy CDN縮圖預熱器
===

使用前提，你的imgproxy伺服器要掛上CDN，並確認 `cf-cache-status` 狀態有正常啟用快取。（如果出現`cf-cache-status: DYNAMIC`代表沒啟用快取）

另外因為不同的Teldrive登入階段session不同，會導致進入imgproxy的網址在hash參數不同，導致快取無效，所以imgproxy那邊還要多掛一層 Cloudflare Worker 來處理網址的正規化：移除 hash 參數。

## Imgproxy 網址正規劃處理

建立一支Cloudflare Worker，並將 imgproxy 的域名以「路由」形式掛上該 worker。

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 建立一個「乾淨」的 URL 作為快取的 Key (不含 hash)
    let cacheUrl = new URL(request.url);
    if (cacheUrl.pathname.includes('tdrive.yuaner.tw') && cacheUrl.pathname.includes('%3Fhash%3D')) {
      cacheUrl.pathname = cacheUrl.pathname.split('%3Fhash%3D')[0];
    }
    const cacheKey = new Request(cacheUrl.toString(), {
      method: request.method,
      headers: request.headers
    });

    const cache = caches.default;

    // 2. 嘗試從快取中讀取（用乾淨的 Key）
    let response = await cache.match(cacheKey);

    if (!response) {
      console.log("快取失效，正在使用原始請求抓取圖片...");
      
      // 3. 【關鍵】使用「原始 Request」進行 fetch。
      // 這確保了路徑中編碼過的 %3Fhash%3D 會原封不動地傳給 imgproxy
      response = await fetch(request);

      // 4. 如果 imgproxy 成功回傳 (200 OK)
      if (response.ok) {
        // 為了能修改 Header，必須重新建立 Response
        let newHeaders = new Headers(response.headers);
        newHeaders.delete("Vary");
        newHeaders.set("X-Worker-Cache", "MISS");

        // 複製 Body 以便存入快取的同時回傳給瀏覽器
        const responseToCache = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });

        // 5. 將結果存入快取，但綁定在「乾淨的 Key」上
        ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
        
        return responseToCache;
      }
    } else {
      console.log("快取命中！");
      // 修改 Header 方便除錯
      let hitHeaders = new Headers(response.headers);
      hitHeaders.set("X-Worker-Cache", "HIT");
      return new Response(response.body, { headers: hitHeaders });
    }

    return response;
  }
};
```

## 設定內部參數
請到 `prewarm.js` 內設定 `CONFIG.teldriveBaseUrl` 與 `CONFIG.imgproxyBaseUrl`。

## 執行
- `--access_token` 請從當前登入的Cookie去找access_token並貼入
- `--path` 可貼入路徑字串，或是直接從網址複製已被URL Encode的路徑也可以
- `--threads` 限制同時執行的執行緒數 (預設 10)
- `--size-limit` 限制同時處理的圖片原始大小總和 (MB, 預設 100)
- `--limit` 限制總處理圖片數量，達到後即停止

### 互動對話式
```bash
node prewarm.js 
```

### 爬取近期上傳
```bash
node prewarm.js --recent --access_token="[ENCRYPTION_KEY]"
```

### 爬取指定資料夾
```bash
node prewarm.js --path="%2F圖集%2F測試圖集庫" --access_token="[ENCRYPTION_KEY]"
```

```bash
node prewarm.js --path="/圖集/測試圖集庫" --access_token="[ENCRYPTION_KEY]"
```

