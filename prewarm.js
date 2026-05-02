const readline = require('readline');

const CONFIG = {
    teldriveBaseUrl: 'https://tdrive.yuaner.tw',
    imgproxyBaseUrl: 'https://imgproxy.yuaner.tw',
    statsInterval: 30,
    maxConcurrentSizeBytes: 100 * 1024 * 1024, // 100MB
    threads: 10,
    limit: 0
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (query) => new Promise(resolve => rl.question(query, resolve));

const colors = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m"
};

function formatElapsed(startTime) {
    const elapsedMs = Date.now() - startTime;
    const seconds = Math.floor((elapsedMs / 1000) % 60);
    const minutes = Math.floor((elapsedMs / (1000 * 60)) % 60);
    const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
    return `${hours}h ${minutes}m ${seconds}s`;
}

function printStats(stats, startTime, isFinal = false) {
    const title = isFinal ? "=== 執行完畢 ===" : `=== 中途統計 (第 ${stats.total} 筆) ===`;
    console.log(`\n${colors.cyan}${title}${colors.reset}`);
    console.log(`總計處理圖片: ${stats.total}`);
    console.log(`${colors.green}HIT: ${stats.hit}${colors.reset}`);
    console.log(`MISS: ${stats.miss}`);
    console.log(`其他狀態: ${stats.other}`);
    console.log(`已執行時間: ${formatElapsed(startTime)}`);
    if (!isFinal) console.log(`${colors.cyan}====================================${colors.reset}\n`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        help: false,
        recent: false,
        access_token: '',
        cookie: '',
        path: '',
        hash: '',
        threads: 0,
        sizeLimit: 0,
        limit: 0
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help') options.help = true;
        else if (arg === '--recent') options.recent = true;
        else if (arg.startsWith('--access_token=')) options.access_token = arg.substring(15);
        else if (arg === '--access_token') options.access_token = args[++i];
        else if (arg.startsWith('--cookie=')) options.cookie = arg.substring(9);
        else if (arg === '--cookie') options.cookie = args[++i];
        else if (arg.startsWith('--path=')) options.path = arg.substring(7);
        else if (arg === '--path') options.path = args[++i];
        else if (arg.startsWith('--hash=')) options.hash = arg.substring(7);
        else if (arg === '--hash') options.hash = args[++i];
        else if (arg.startsWith('--threads=')) options.threads = arg.substring(10);
        else if (arg === '--threads') options.threads = args[++i];
        else if (arg.startsWith('--size-limit=')) options.sizeLimit = arg.substring(13);
        else if (arg === '--size-limit') options.sizeLimit = args[++i];
        else if (arg.startsWith('--limit=')) options.limit = arg.substring(8);
        else if (arg === '--limit') options.limit = args[++i];
    }
    return options;
}

function showHelp() {
    console.log(`用法: node prewarm.js [選項]

選項:
  --recent                爬取模式：近期上傳 (全局)
  --path <url/path>       爬取模式：指定資料夾遞迴。可直接貼上 API 網址，或是正規路徑 (如 "/[0] PT已下載備份/M-Team")
  --access_token <token>  設定 access_token (會自動轉為 Cookie)
  --cookie <cookie>       直接設定完整的 Cookie 字串
  --hash <hash>           手動指定 Hash (若不指定，將嘗試從 API 自動抓取)
  --threads <num>         限制同時執行的執行緒數 (預設 10, 完全單線程請設 1)
  --size-limit <mb>       限制同時處理的圖片原始大小總和 (MB, 預設 100)
  --limit <num>           限制總處理圖片數量，達到後即停止
  --help                  顯示此幫助訊息

範例:
  node prewarm.js --recent --access_token="eyJhbGci..."
  node prewarm.js --path="/[0] PT已下載備份/M-Team/[0] 圖集" --access_token="..."
`);
}

async function fetchApi(url, cookie) {
    const res = await fetch(url, {
        headers: {
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
        }
    });
    if (!res.ok) {
        throw new Error(`API 請求失敗: ${res.status} ${res.statusText}`);
    }
    return await res.json();
}

async function prewarmImage(file, manualHash) {
    const hash = file.hash || manualHash;
    if (!hash) {
        return { error: '找不到 hash，請提供手動 hash' };
    }

    const fileUrl = `${CONFIG.teldriveBaseUrl}/api/files/${file.id}/${encodeURIComponent(file.name)}?hash=${hash}`;
    const encodedFileUrl = encodeURIComponent(fileUrl);
    // 根據您的範例，使用雙斜線 //insecure...
    const imgproxyUrl = `${CONFIG.imgproxyBaseUrl}//insecure/w:360/plain/${encodedFileUrl}`;

    try {
        const res = await fetch(imgproxyUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'Teldrive-Prewarm-Crawler/1.0' }
        });
        
        // consume the body to free memory
        await res.arrayBuffer();
        
        const cacheStatus = res.headers.get('cf-cache-status');
        return { status: res.status, cacheStatus: cacheStatus || 'null (無此標頭)', url: imgproxyUrl };
    } catch (e) {
        return { error: e.message };
    }
}

function isImage(file) {
    return file.mimeType && file.mimeType.startsWith('image/');
}

async function main() {
    const opts = parseArgs();
    
    if (opts.help) {
        showHelp();
        process.exit(0);
    }

    if (opts.threads) CONFIG.threads = parseInt(opts.threads);
    if (opts.sizeLimit) CONFIG.maxConcurrentSizeBytes = parseInt(opts.sizeLimit) * 1024 * 1024;
    if (opts.limit) CONFIG.limit = parseInt(opts.limit);

    console.log(`${colors.cyan}=== Teldrive imgproxy 預覽縮圖熱預載爬蟲 ===${colors.reset}\n`);
    
    let mode = '';
    let baseFolderUrl = '';
    let startPath = '';

    if (opts.recent) {
        mode = '1';
    } else if (opts.path) {
        mode = '2';
        if (opts.path.startsWith('http://') || opts.path.startsWith('https://')) {
            try {
                const urlObj = new URL(opts.path);
                startPath = urlObj.searchParams.get('path') || '';
                baseFolderUrl = opts.path;
            } catch (e) {
                console.log(`${colors.red}網址解析失敗，請確認輸入正確。${colors.reset}`);
                process.exit(1);
            }
        } else {
            try {
                startPath = decodeURIComponent(opts.path.replace(/\+/g, ' '));
            } catch (e) {
                startPath = opts.path;
            }
            baseFolderUrl = `${CONFIG.teldriveBaseUrl}/api/files?order=asc&sort=name`;
        }
    } else {
        mode = await ask("請選擇爬取模式:\n1. 近期上傳 (全局)\n2. 指定資料夾遞迴\n請輸入 (1 或 2): ");
        if (mode === '2') {
            baseFolderUrl = await ask("請輸入資料夾 API 網址 (如 https://tdrive.yuaner.tw/api/files?...): ");
            try {
                const urlObj = new URL(baseFolderUrl);
                startPath = urlObj.searchParams.get('path') || '';
            } catch (e) {
                console.log(`${colors.red}網址解析失敗，請確認輸入正確。${colors.reset}`);
                process.exit(1);
            }
        }
    }

    let cookie = opts.cookie;
    if (!cookie && opts.access_token) {
        cookie = `access_token=${opts.access_token}`;
    }

    if (!cookie) {
        cookie = await ask("\n請輸入您的 Cookies (包含 access_token 等，這將用於取得檔案列表): ");
    }

    let jwtToken = opts.access_token;
    if (!jwtToken && cookie) {
        const match = cookie.match(/access_token=([^;]+)/);
        if (match) jwtToken = match[1];
    }

    let inferredHash = null;
    if (jwtToken) {
        try {
            const payloadPart = jwtToken.split('.')[1];
            if (payloadPart) {
                const payload = JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf8'));
                if (payload.hash) inferredHash = payload.hash;
            }
        } catch (e) {
            // Ignore parse error
        }
    }

    let manualHash = opts.hash || inferredHash;
    const isInteractive = !opts.recent && !opts.path && !opts.cookie && !opts.access_token;
    if (!manualHash && isInteractive) {
        manualHash = await ask("\n請輸入 Hash (可留空，若留空將嘗試從 API 檔案資訊中的 file.hash 自動推斷): ");
    }

    console.log(`\n${colors.cyan}開始爬取...${colors.reset}\n`);

    const startTime = Date.now();
    let stats = { hit: 0, miss: 0, other: 0, total: 0, enqueued: 0 };
    
    let activePromises = new Set();
    let currentProcessingBytes = 0;
    let shouldStop = false;

    async function enqueueItem(item, displayName, manualHash, stats, startTime) {
        if (CONFIG.limit > 0 && stats.enqueued >= CONFIG.limit) {
            shouldStop = true;
            return;
        }

        const fileSize = item.size || 0;
        
        while (activePromises.size > 0 && (
            (currentProcessingBytes + fileSize > CONFIG.maxConcurrentSizeBytes && activePromises.size > 0) || 
            activePromises.size >= CONFIG.threads
        )) {
            await Promise.race(activePromises);
        }

        if (CONFIG.limit > 0 && stats.enqueued >= CONFIG.limit) {
            shouldStop = true;
            return;
        }

        stats.enqueued++;
        currentProcessingBytes += fileSize;
        
        const p = (async () => {
            try {
                await processItem(item, displayName, manualHash, stats, startTime);
            } finally {
                currentProcessingBytes -= fileSize;
            }
        })();
        
        activePromises.add(p);
        p.finally(() => activePromises.delete(p));
    }
    
    if (mode === '1') {
        // Mode 1: Global recent files
        let page = 1;
        while (!shouldStop) {
            const url = `${CONFIG.teldriveBaseUrl}/api/files?page=${page}&order=desc&sort=updatedAt&operation=find&type=file`;
            try {
                const data = await fetchApi(url, cookie);
                const items = Array.isArray(data) ? data : (data.data || data.items || data.results || []);
                
                if (items.length === 0) break;

                for (const item of items) {
                    if (isImage(item)) {
                        await enqueueItem(item, item.name, manualHash, stats, startTime);
                        if (shouldStop) break;
                    }
                }
                
                if (!data.hasNextPage && !data.next_page_url && items.length < 10) {
                    // Just a heuristic to break if pagination is done
                }
                page++;
            } catch (e) {
                console.error(`獲取第 ${page} 頁失敗: ${e.message}`);
                break;
            }
        }
    } else if (mode === '2') {
        // Mode 2: Recursive folder
        let queue = [startPath];
        const baseUrlObj = new URL(baseFolderUrl);
        
        while (queue.length > 0 && !shouldStop) {
            const currentPath = queue.shift();
            let page = 1;
            
            while (!shouldStop) {
                // Construct URL for current path and page manually to match Teldrive's expected encoding
                const url = `${CONFIG.teldriveBaseUrl}/api/files?page=${page}&order=asc&sort=name&path=${encodeURIComponent(currentPath)}`;
                
                try {
                    const data = await fetchApi(url, cookie);
                    const items = Array.isArray(data) ? data : (data.data || data.items || data.results || []);
                    
                    if (items.length === 0) break;

                    for (const item of items) {
                        const fullPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
                        if (item.type === 'folder' || item.mimeType === 'application/vnd.teldrive.folder') {
                            queue.push(fullPath);
                        } else if (isImage(item)) {
                            await enqueueItem(item, fullPath, manualHash, stats, startTime);
                            if (shouldStop) break;
                        }
                    }
                    page++;
                } catch (e) {
                    console.error(`獲取資料夾 ${currentPath} 第 ${page} 頁失敗: ${e.message}`);
                    break;
                }
            }
        }
    }

    while (activePromises.size > 0) {
        await Promise.all(activePromises);
    }

    printStats(stats, startTime, true);
    
    process.exit(0);
}

async function processItem(item, displayName, manualHash, stats, startTime) {
    const result = await prewarmImage(item, manualHash);
    
    stats.total++;
    
    let statusText = '';
    if (result.error) {
        stats.other++;
        statusText = `${colors.yellow}錯誤 (${result.error})${colors.reset}`;
    } else if (result.cacheStatus === 'HIT') {
        stats.hit++;
        statusText = `${colors.green}HIT${colors.reset}`;
    } else if (result.cacheStatus === 'MISS') {
        stats.miss++;
        statusText = `MISS`;
    } else if (result.cacheStatus === 'DYNAMIC') {
        stats.other++;
        statusText = `${colors.red}DYNAMIC (警告: 此請求未被快取，變為無效動作)${colors.reset}`;
    } else {
        stats.other++;
        statusText = `${colors.yellow}${result.cacheStatus}${colors.reset}`;
    }

    console.log(`[${stats.total}] 處理完畢: ${displayName} ... ${statusText}`);

    if (stats.total % CONFIG.statsInterval === 0) {
        printStats(stats, startTime);
    }
}

main().catch(console.error);
