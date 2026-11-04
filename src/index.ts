import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 8787;
const STATE_FILE = path.join(process.cwd(), '.state.json');
const TOKENS_FILE = path.join(process.cwd(), '.tokens.json');

// 支持双模式：
// 1. 'v4' (默认)：调用城通官方最新客户端 REST API v4 (https://api.ctfile.com/v4)，免费账号可用，支持扫码登录与多账号自动轮询刷新；
// 2. 'v1'：调用城通开放接口 REST API v1 (https://rest.ctfile.com/v1)，仅限 VIP 会员通过后台生成的 session 使用。
const API_MODE = process.env.CTFILE_API_MODE || 'v4';
const V4_API_BASE = (process.env.CTFILE_V4_API_BASE || 'https://api.ctfile.com').replace(/\/+$/, '');
const V1_API_BASE = (process.env.CTFILE_V1_API_BASE || 'https://rest.ctfile.com/v1').replace(/\/+$/, '');
const XTLINK_PREFIX = process.env.CTFILE_XTLINK_PREFIX || '';
const CARRIER = process.env.CTFILE_CARRIER ? Number(process.env.CTFILE_CARRIER) : 0;

interface AppState {
	tokenIndex: number;
}

interface DownloadInfo {
	key: string;
	name?: string;
}

interface V4Account {
	id: string;
	refreshToken?: string;
	accessToken?: string;
	accessTokenExpiresAt?: number;
	username?: string;
}

const V4_CLIENT_HEADERS: Record<string, string> = {
	'X-Client-Type': 'native',
	'X-Client-Version': '5.1.24',
	'X-Client-Platform': 'linux',
	'X-Client-OS-Version': '6.1.0',
	'X-Client-Arch': 'x64',
	'X-Client-Captcha': 'image,turnstile,altcha,cap',
	'User-Agent': 'Mozilla/5.0 CTFileApp/5.1.24',
	'Content-Type': 'application/json',
	Accept: 'application/json',
};

let SESSIONS: string[] = [];
let V4_ACCOUNTS: V4Account[] = [];
let appState: AppState = { tokenIndex: 0 };

function loadState(): void {
	try {
		if (fs.existsSync(STATE_FILE)) {
			const data = fs.readFileSync(STATE_FILE, 'utf-8');
			appState = JSON.parse(data);
		}
	} catch (error) {
		console.warn('Failed to load state file, using defaults:', error);
		appState = { tokenIndex: 0 };
	}
}

function saveState(): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), 'utf-8');
	} catch (error) {
		console.error('Failed to save state file:', error);
	}
}

function loadTokensFile(): void {
	try {
		if (fs.existsSync(TOKENS_FILE)) {
			const data = fs.readFileSync(TOKENS_FILE, 'utf-8');
			const parsed = JSON.parse(data);
			if (Array.isArray(parsed)) {
				// 合并已有账号，去重
				for (const item of parsed) {
					if (item && (item.refreshToken || item.accessToken)) {
						const key = item.refreshToken || item.accessToken;
						const exists = V4_ACCOUNTS.some(
							(a) => a.refreshToken === key || a.accessToken === key
						);
						if (!exists) {
							V4_ACCOUNTS.push({
								id: String(item.id || item.userId || V4_ACCOUNTS.length + 1),
								refreshToken: item.refreshToken,
								accessToken: item.accessToken,
								accessTokenExpiresAt: item.accessTokenExpiresAt || 0,
								username: item.username,
							});
						}
					}
				}
			}
		}
	} catch (error) {
		console.warn('Failed to load tokens file:', error);
	}
}

function saveTokensFile(): void {
	try {
		fs.writeFileSync(TOKENS_FILE, JSON.stringify(V4_ACCOUNTS, null, 2), 'utf-8');
	} catch (error) {
		console.error('Failed to save tokens file:', error);
	}
}

class UpstreamError extends Error {
	code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = 'UpstreamError';
		this.code = code;
	}
}

// ======================== v4 客户端接口实现 (免费账号免会员) ========================
class CTFileV4API {
	private async post<T>(
		endpoint: string,
		payload: Record<string, unknown>,
		accessToken?: string
	): Promise<T> {
		const url = `${V4_API_BASE}${endpoint}`;
		const headers: Record<string, string> = { ...V4_CLIENT_HEADERS };
		if (accessToken) {
			headers['Authorization'] = `Bearer ${accessToken}`;
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
			});
		} catch (error: any) {
			throw new Error(`无法连接上游 API ${url}: ${error.message}`);
		}

		const text = await response.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`上游返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
		}

		if (data && typeof data.code !== 'undefined' && data.code !== 200) {
			throw new UpstreamError(Number(data.code), data.message || `上游返回错误码 ${data.code}`);
		}

		return data as T;
	}

	async generateQrCode(): Promise<{ qr_key: string; qr_content: string; qr_url: string }> {
		const res = await this.post<{
			code: number;
			data: { qr_key: string; qr_content: string; qr_url: string };
		}>('/v4/user/auth/generate-qr-code', {});
		return res.data;
	}

	async checkQrCode(qr_key: string): Promise<{
		status: 'pending' | 'scanned' | 'confirmed' | 'expired';
		token?: string;
		refresh_token?: string;
		expires_in?: number;
		user?: any;
	}> {
		const res = await this.post<{
			code: number;
			data?: any;
			token?: string;
			refresh_token?: string;
			expires_in?: number;
			user?: any;
		}>('/v4/user/auth/check-qr-code', {
			qr_key,
			device_type: 'Linux',
			device_info: 'Desktop Client v5.1.24',
			client_version: 'v4qr',
		});

		const data = res.data || {};
		const status = data.status || (res.token ? 'confirmed' : 'pending');
		return {
			status,
			token: res.token || data.token,
			refresh_token: res.refresh_token || data.refresh_token,
			expires_in: res.expires_in || data.expires_in,
			user: res.user || data.user,
		};
	}

	async refreshToken(
		refreshToken: string
	): Promise<{ token: string; refresh_token?: string; expires_in?: number }> {
		const res = await this.post<{
			code: number;
			data?: any;
			token?: string;
			refresh_token?: string;
			expires_in?: number;
		}>('/v4/user/auth/refresh-token', {
			refresh_token: refreshToken,
			rotate_token: true,
		});

		const token = res.token || res.data?.token || res.data?.access_token;
		if (!token) {
			throw new Error('刷新 Token 失败，上游未返回有效 access_token');
		}

		return {
			token,
			refresh_token: res.refresh_token || res.data?.refresh_token || refreshToken,
			expires_in: res.expires_in || res.data?.expires_in || 900,
		};
	}

	async list(
		xtlink: string,
		accessToken: string,
		folderId: string | number = 0,
		basePath?: string
	): Promise<DownloadInfo[]> {
		const allFiles: DownloadInfo[] = [];
		const seenKeys = new Set<string>();
		let start = 0;
		const pageSize = 100;

		const normalizedFolderId =
			typeof folderId === 'string' && folderId.startsWith('d')
				? folderId.slice(1)
				: folderId || 0;

		for (let page = 0; page < 100; page++) {
			const reqResult = await this.post<{
				code: number;
				data?: { results?: any[]; totalNum?: number; num?: number };
				results?: any[];
			}>(
				'/v4/public/browser/list',
				{
					xtlink,
					folder_id: normalizedFolderId,
					start,
					pagesize: pageSize,
				},
				accessToken
			);

			const items = reqResult.data?.results || reqResult.results || [];
			if (items.length === 0) break;

			const newItems = items.filter((item) => {
				const id = item?.fid || item?.key || item?.id;
				return id && !seenKeys.has(String(id));
			});
			if (newItems.length === 0) break;

			for (const item of newItems) {
				const itemKey = String(item.fid || item.key || item.id);
				seenKeys.add(itemKey);

				const currentName = basePath ? `${basePath}/${item.name}` : item.name;
				const isFolder =
					item.is_folder === true ||
					item.type === 'folder' ||
					item.icon === 'folder' ||
					item.ext === 'folder' ||
					itemKey.startsWith('d');

				if (isFolder) {
					const subFiles = await this.list(xtlink, accessToken, itemKey, currentName);
					allFiles.push(...subFiles);
				} else {
					allFiles.push({
						key: itemKey,
						name: currentName,
					});
				}
			}

			start += items.length;
			const total = reqResult.data?.totalNum ?? reqResult.data?.num;
			if (typeof total === 'number' && start >= total) break;
		}

		return allFiles;
	}

	async download(
		xtlink: string,
		fileId: string,
		accessToken: string
	): Promise<{ code: number; download_url: string }> {
		const normalizedId = /^[fd]\d+$/.test(fileId) ? fileId.slice(1) : fileId;

		// 1. 获取下载签名
		const authResult = await this.post<{
			code: number;
			data?: { download_signature?: string };
			download_signature?: string;
		}>(
			'/v4/public/browser/create-download-auth',
			{
				xtlink,
				ids: normalizedId,
			},
			accessToken
		);

		const signature =
			authResult.data?.download_signature || authResult.download_signature;
		if (!signature) {
			throw new Error('未能获取 download_signature 下载签名');
		}

		// 2. 换取直链
		const directResult = await this.post<{
			code: number;
			download_url?: string;
		}>('/v4/file/browse/fetch-url-direct', {
			download_sign: signature,
			carrier: CARRIER,
		});

		if (!directResult.download_url) {
			throw new Error('上游接口未返回 download_url 直链');
		}

		return {
			code: 200,
			download_url: directResult.download_url,
		};
	}
}

// ======================== v1 开放接口实现 (会员模式) ========================
class CTFileV1API {
	private async post<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
		const url = `${V1_API_BASE}${endpoint}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'User-Agent': 'okhttp/4.9.2',
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify(payload),
			});
		} catch (error: any) {
			throw new Error(`无法连接上游 API ${url}: ${error.message}`);
		}

		const text = await response.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`上游返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
		}

		if (data && typeof data.code !== 'undefined' && data.code !== 200) {
			throw new UpstreamError(Number(data.code), data.message || `上游返回错误码 ${data.code}`);
		}

		return data as T;
	}

	async list(
		xtlink: string,
		session: string,
		folder_id?: string,
		basePath?: string
	): Promise<DownloadInfo[]> {
		const allFiles: DownloadInfo[] = [];
		const seenKeys = new Set<string>();
		let start = 0;

		for (let page = 0; page < 1000; page++) {
			const reqResult = await this.post<{ results?: any[]; num?: number }>('/browser/file/list', {
				xtlink,
				folder_id: folder_id || 'd0',
				start,
				session,
			});

			const items = reqResult.results || [];
			if (items.length === 0) break;

			const newItems = items.filter((item) => item && item.key && !seenKeys.has(item.key));
			if (newItems.length === 0) break;

			for (const item of newItems) {
				seenKeys.add(item.key);
				const currentName = basePath ? `${basePath}/${item.name}` : item.name;
				if (item.icon === 'folder') {
					const subFiles = await this.list(xtlink, session, item.key, currentName);
					allFiles.push(...subFiles);
				} else {
					allFiles.push({
						key: item.key,
						name: currentName,
					});
				}
			}

			start += items.length;
		}

		return allFiles;
	}

	async download(
		xtlink: string,
		file_id: string,
		session: string
	): Promise<{ code: number; download_url: string }> {
		const payload = (id: string) => ({
			xtlink,
			file_id: id,
			carrier: CARRIER,
			session,
		});

		const normalizedId = /^[fd]\d+$/.test(file_id) ? file_id.slice(1) : file_id;
		try {
			return await this.post('/browser/file/fetch_url', payload(normalizedId));
		} catch (error) {
			if (
				normalizedId !== file_id &&
				error instanceof UpstreamError &&
				(error.code === 400 || error.code === 404)
			) {
				return this.post('/browser/file/fetch_url', payload(file_id));
			}
			throw error;
		}
	}
}

const v4Api = new CTFileV4API();
const v1Api = new CTFileV1API();

function normalizeXtlink(xtlink: string): string {
	const bare = xtlink.startsWith('ctfile://') ? xtlink.slice('ctfile://'.length) : xtlink;
	return `${XTLINK_PREFIX}${bare}`;
}

async function getV4AccessToken(): Promise<string> {
	if (V4_ACCOUNTS.length === 0) {
		throw new Error(
			'未配置可用账号。你可以访问服务主页上的「/qr」页面，使用城通网盘手机 App 扫码登录（无需会员）；或者在环境变量中配置 REFRESH_TOKENS。'
		);
	}

	const index = Math.abs(appState.tokenIndex) % V4_ACCOUNTS.length;
	const account = V4_ACCOUNTS[index];
	appState.tokenIndex = (index + 1) % V4_ACCOUNTS.length;
	saveState();

	const now = Date.now();
	// 如果已有有效 access_token（且距离过期还有 60 秒以上），直接使用
	if (account.accessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt > now + 60000) {
		return account.accessToken;
	}

	// 否则尝试使用 refresh_token 刷新
	if (account.refreshToken) {
		try {
			console.log(`正在为账号 ${account.id} 自动刷新 access_token...`);
			const refreshResult = await v4Api.refreshToken(account.refreshToken);
			account.accessToken = refreshResult.token;
			account.accessTokenExpiresAt = now + (refreshResult.expires_in || 900) * 1000;
			if (refreshResult.refresh_token) {
				account.refreshToken = refreshResult.refresh_token;
			}
			saveTokensFile();
			return account.accessToken;
		} catch (error: any) {
			console.error(`账号 ${account.id} 刷新 Token 失败:`, error.message);
			// 如果当前账号已失效且有 accessToken，尝试降级使用原有 accessToken
			if (account.accessToken) return account.accessToken;
			throw error;
		}
	}

	if (account.accessToken) {
		return account.accessToken;
	}

	throw new Error(`账号 ${account.id} 无有效的 access_token 或 refresh_token`);
}

function getV1Session(): string {
	if (Array.isArray(SESSIONS) && SESSIONS.length > 0) {
		const index = Math.abs(appState.tokenIndex) % SESSIONS.length;
		const session = SESSIONS[index];
		appState.tokenIndex = (index + 1) % SESSIONS.length;
		saveState();
		return session;
	}
	throw new Error(
		'未配置可用的 session。如使用 v1 开放接口模式，请在城通后台「开放接口登录密钥管理」生成 session 并通过 SESSIONS 环境变量配置。'
	);
}

// 渲染扫码登录的前端 HTML 页面
function renderQrLoginPage(): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>城通网盘账号扫码登录 (免会员)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f3f4f6;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 32px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0,0,0,0.05);
      text-align: center;
    }
    h1 { font-size: 20px; color: #111827; margin-bottom: 8px; font-weight: 600; }
    p.desc { font-size: 13px; color: #6b7280; margin-bottom: 24px; line-height: 1.5; }
    .badge {
      display: inline-block;
      background: #ecfdf5;
      color: #059669;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 500;
      margin-bottom: 16px;
    }
    .qr-container {
      width: 240px;
      height: 240px;
      margin: 0 auto 20px;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fafafa;
      position: relative;
      overflow: hidden;
    }
    .qr-container img { width: 100%; height: 100%; object-fit: contain; }
    .status {
      font-size: 14px;
      font-weight: 500;
      color: #4b5563;
      margin-bottom: 16px;
      min-height: 20px;
    }
    .status.success { color: #059669; }
    .status.expired { color: #dc2626; }
    .btn {
      display: inline-block;
      background: #2563eb;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      padding: 10px 20px;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: background 0.2s;
    }
    .btn:hover { background: #1d4ed8; }
    .stats {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">免费账号可用 · 无需会员</span>
    <h1>城通网盘扫码登录</h1>
    <p class="desc">打开<strong>城通网盘手机 App</strong>，使用扫一扫扫描下方二维码完成授权。授权后系统将自动保存并在后台持久化自动续期。</p>
    <div class="qr-container" id="qrContainer">
      <span id="loadingText" style="color: #9ca3af; font-size: 13px;">正在生成二维码...</span>
      <img id="qrImg" style="display: none;" alt="二维码">
    </div>
    <div class="status" id="statusText">等待生成二维码...</div>
    <div>
      <button class="btn" id="refreshBtn" onclick="initQr()">刷新二维码</button>
    </div>
    <div class="stats" id="accountsStats">加载账号状态中...</div>
  </div>

  <script>
    let pollTimer = null;
    let currentKey = null;

    async function loadStats() {
      try {
        const res = await fetch('/auth/accounts');
        const data = await res.json();
        const el = document.getElementById('accountsStats');
        el.innerHTML = '已配置可用账号数: <strong>' + data.count + '</strong> (模式: ' + data.mode + ')';
      } catch (e) {}
    }

    async function initQr() {
      if (pollTimer) clearInterval(pollTimer);
      const statusEl = document.getElementById('statusText');
      const imgEl = document.getElementById('qrImg');
      const loadEl = document.getElementById('loadingText');

      statusEl.className = 'status';
      statusEl.textContent = '正在获取二维码...';
      imgEl.style.display = 'none';
      loadEl.style.display = 'block';

      try {
        const res = await fetch('/auth/qr/generate');
        const data = await res.json();
        if (data.code !== 200 || !data.qr_key) {
          statusEl.className = 'status expired';
          statusEl.textContent = data.error || '获取二维码失败，请重试';
          return;
        }

        currentKey = data.qr_key;
        imgEl.src = data.qr_url;
        imgEl.onload = () => {
          loadEl.style.display = 'none';
          imgEl.style.display = 'block';
        };
        statusEl.textContent = '请打开城通网盘手机 App 扫码';

        pollTimer = setInterval(checkStatus, 2000);
      } catch (err) {
        statusEl.className = 'status expired';
        statusEl.textContent = '网络连接错误: ' + err.message;
      }
    }

    async function checkStatus() {
      if (!currentKey) return;
      try {
        const res = await fetch('/auth/qr/check?qr_key=' + encodeURIComponent(currentKey));
        const data = await res.json();
        const statusEl = document.getElementById('statusText');

        if (data.status === 'scanned') {
          statusEl.textContent = '📱 已扫描，请在手机上点击确认登录...';
        } else if (data.status === 'confirmed') {
          clearInterval(pollTimer);
          pollTimer = null;
          statusEl.className = 'status success';
          statusEl.innerHTML = '🎉 登录成功！账号已成功加入解析池。';
          loadStats();
        } else if (data.status === 'expired') {
          clearInterval(pollTimer);
          pollTimer = null;
          statusEl.className = 'status expired';
          statusEl.textContent = '二维码已过期，请点击下方刷新重试。';
        }
      } catch (e) {}
    }

    initQr();
    loadStats();
  </script>
</body>
</html>`;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const url = new URL(req.url || '', `http://${req.headers.host}`);
	const params = url.searchParams;
	const pathname = url.pathname;

	// CORS headers
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', '*');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.method !== 'GET') {
		res.writeHead(405);
		res.end('Method Not Allowed');
		return;
	}

	try {
		if (pathname === '/meow') {
			res.writeHead(200);
			res.end('Meow!');
			return;
		}

		if (pathname === '/config') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					mode: API_MODE,
					v4ApiBase: V4_API_BASE,
					v1ApiBase: V1_API_BASE,
					v4AccountsConfigured: V4_ACCOUNTS.length,
					v1SessionsConfigured: SESSIONS.length,
				})
			);
			return;
		}

		// 网页版扫码登录页面
		if (pathname === '/qr' || pathname === '/login/qr') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(renderQrLoginPage());
			return;
		}

		// 生成二维码 API
		if (pathname === '/auth/qr/generate') {
			const qr = await v4Api.generateQrCode();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ code: 200, ...qr }));
			return;
		}

		// 检查二维码状态 API
		if (pathname === '/auth/qr/check') {
			const qr_key = params.get('qr_key');
			if (!qr_key) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ code: 400, error: 'Missing qr_key' }));
				return;
			}

			const checkResult = await v4Api.checkQrCode(qr_key);
			// 如果确认登录成功，自动加入账号池并持久化
			if (checkResult.status === 'confirmed' && (checkResult.refresh_token || checkResult.token)) {
				const tokenKey = checkResult.refresh_token || checkResult.token;
				const exists = V4_ACCOUNTS.some(
					(a) => a.refreshToken === tokenKey || a.accessToken === tokenKey
				);
				if (!exists) {
					V4_ACCOUNTS.push({
						id: String(checkResult.user?.userid || V4_ACCOUNTS.length + 1),
						refreshToken: checkResult.refresh_token,
						accessToken: checkResult.token,
						accessTokenExpiresAt: Date.now() + (checkResult.expires_in || 900) * 1000,
						username: checkResult.user?.username,
					});
					saveTokensFile();
					console.log(`成功添加新账号 (用户ID: ${checkResult.user?.userid || 'unknown'})，当前总账号数: ${V4_ACCOUNTS.length}`);
				}
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ code: 200, ...checkResult }));
			return;
		}

		// 获取当前账号统计
		if (pathname === '/auth/accounts') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					mode: API_MODE,
					count: API_MODE === 'v1' ? SESSIONS.length : V4_ACCOUNTS.length,
					accounts: V4_ACCOUNTS.map((a, i) => ({
						index: i,
						id: a.id,
						hasRefreshToken: Boolean(a.refreshToken),
						hasAccessToken: Boolean(a.accessToken),
						expiresInSeconds: a.accessTokenExpiresAt
							? Math.max(0, Math.round((a.accessTokenExpiresAt - Date.now()) / 1000))
							: 0,
					})),
				})
			);
			return;
		}

		const password = params.get('password');
		const PASSWORD = process.env.PASSWORD;

		if (pathname === '/login') {
			if (!PASSWORD || password === PASSWORD) {
				res.writeHead(200);
				res.end('true');
				return;
			} else {
				res.writeHead(200);
				res.end('false');
				return;
			}
		}

		if (PASSWORD && password !== PASSWORD) {
			res.writeHead(403);
			res.end('Wrong Password');
			return;
		}

		// 处理下载与信息查询
		if (pathname === '/download') {
			let xtlink = params.get('xtlink');
			const file_id = params.get('file_id');

			if (!xtlink || !file_id) {
				res.writeHead(400);
				res.end('Missing required parameters');
				return;
			}

			xtlink = normalizeXtlink(xtlink);

			let upstreamUrl: string;
			if (API_MODE === 'v1') {
				const session = params.get('session') || params.get('token') || getV1Session();
				const result = await v1Api.download(xtlink, file_id, session);
				upstreamUrl = result.download_url;
			} else {
				// v4 客户端协议模式
				const customToken = params.get('token') || params.get('session');
				const token = customToken || (await getV4AccessToken());
				const result = await v4Api.download(xtlink, file_id, token);
				upstreamUrl = result.download_url;
			}

			if (!upstreamUrl) {
				res.writeHead(502);
				res.end('No download_url returned');
				return;
			}

			res.writeHead(302, { Location: upstreamUrl });
			res.end();
			return;
		}

		if (pathname === '/download_info') {
			let xtlink = params.get('xtlink');
			const download = params.get('download') === 'true';
			const file_id = params.getAll('file_id');

			if (!xtlink) {
				res.writeHead(400);
				res.end('Missing "xtlink" parameter');
				return;
			}

			xtlink = normalizeXtlink(xtlink);

			let filesToDownload: DownloadInfo[];

			if (API_MODE === 'v1') {
				const session = params.get('session') || params.get('token') || getV1Session();
				if (file_id.length > 0) {
					filesToDownload = file_id.map((key) => ({ key }));
				} else {
					filesToDownload = await v1Api.list(xtlink, session);
				}

				const results = await Promise.all(
					filesToDownload.map(async (file) => {
						if (!download) {
							return file;
						} else {
							const dl = await v1Api.download(xtlink!, file.key, session);
							return { ...file, downloadUrl: dl.download_url };
						}
					})
				);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(results));
				return;
			} else {
				// v4 客户端模式
				const customToken = params.get('token') || params.get('session');
				const token = customToken || (await getV4AccessToken());

				if (file_id.length > 0) {
					filesToDownload = file_id.map((key) => ({ key }));
				} else {
					filesToDownload = await v4Api.list(xtlink, token);
				}

				const results = await Promise.all(
					filesToDownload.map(async (file) => {
						if (!download) {
							return file;
						} else {
							const dl = await v4Api.download(xtlink!, file.key, token);
							return { ...file, downloadUrl: dl.download_url };
						}
					})
				);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(results));
				return;
			}
		}

		res.writeHead(404);
		res.end('Not Found');
	} catch (error: any) {
		console.error(error);
		const status = error instanceof UpstreamError ? 502 : 500;
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ code: status, error: error.message }));
	}
}

function main(): void {
	// 1. 加载持久化状态与已保存的 token
	loadState();
	loadTokensFile();

	// 2. 加载环境变量中的 Tokens / RefreshTokens / Sessions
	const refreshTokensEnv =
		process.env.REFRESH_TOKENS || process.env.TOKENS || process.env.WEB_TOKENS || '';
	if (refreshTokensEnv) {
		const tokens = refreshTokensEnv
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		for (const t of tokens) {
			const exists = V4_ACCOUNTS.some((a) => a.refreshToken === t || a.accessToken === t);
			if (!exists) {
				V4_ACCOUNTS.push({
					id: `env-${V4_ACCOUNTS.length + 1}`,
					refreshToken: t,
					accessTokenExpiresAt: 0,
				});
			}
		}
	}

	const sessionsEnv = process.env.SESSIONS || '';
	if (sessionsEnv) {
		SESSIONS = sessionsEnv
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	const server = http.createServer(handleRequest);
	const host = process.env.HOST || '0.0.0.0';

	server.listen(Number(PORT), host, () => {
		console.log(`Server is running on http://${host}:${PORT}`);
		console.log(`Current API mode: ${API_MODE} (${API_MODE === 'v4' ? '官方客户端免会员模式' : 'Open API v1会员模式'})`);
		if (API_MODE === 'v4') {
			console.log(`Configured v4 accounts: ${V4_ACCOUNTS.length}`);
			console.log(`QR login page available at: http://${host}:${PORT}/qr`);
		} else {
			console.log(`Configured v1 sessions: ${SESSIONS.length}`);
		}
	});
}

main();
