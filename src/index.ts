import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || process.cwd();
if (!fs.existsSync(DATA_DIR)) {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	} catch (e) {
		console.warn('Failed to create DATA_DIR:', e);
	}
}
const STATE_FILE = path.join(DATA_DIR, '.state.json');
const TOKENS_FILE = path.join(DATA_DIR, '.tokens.json');

// 支持双模式：
// 1. 'v4' (默认)：调用城通官方最新客户端 REST API v4 (https://api.ctfile.com/v4)，免费账号可用，支持扫码登录与多账号自动轮询刷新；
// 2. 'v1'：调用城通开放接口 REST API v1 (https://rest.ctfile.com/v1)，仅限 VIP 会员通过后台生成的 session 使用。
const API_MODE = process.env.CTFILE_API_MODE || 'v4';
const V4_API_BASE = (process.env.CTFILE_V4_API_BASE || 'https://api.ctfile.com').replace(/\/+$/, '');
const V1_API_BASE = (process.env.CTFILE_V1_API_BASE || 'https://rest.ctfile.com/v1').replace(/\/+$/, '');
const XTLINK_PREFIX = process.env.CTFILE_XTLINK_PREFIX || '';
const CARRIER = process.env.CTFILE_CARRIER ? Number(process.env.CTFILE_CARRIER) : 0;

// 上游并发与重试配置。
// 20 个 aria2 线程会同时请求 /download，每个请求都要访问城通上游若干次；
// 不做限流时容易触发上游的风控/限流（返回空响应、HTML 或直接断开连接），
// 表现为本服务返回 500/502，aria2 只看到 "status=500"。
const UPSTREAM_MAX_CONCURRENCY = Math.max(
	1,
	Number(process.env.UPSTREAM_MAX_CONCURRENCY) || 6
);
const UPSTREAM_RETRY_TIMES = Math.max(0, Number(process.env.UPSTREAM_RETRY_TIMES) || 3);
const UPSTREAM_RETRY_BASE_DELAY_MS = Math.max(
	50,
	Number(process.env.UPSTREAM_RETRY_BASE_DELAY_MS) || 300
);
const UPSTREAM_TIMEOUT_MS = Math.max(
	1000,
	Number(process.env.UPSTREAM_TIMEOUT_MS) || 20000
);
// 单个 /download 请求最多尝试几个账号（某个账号 token 失效时自动换号重试）
const DOWNLOAD_ACCOUNT_ATTEMPTS = Math.max(
	1,
	Number(process.env.DOWNLOAD_ACCOUNT_ATTEMPTS) || 3
);

// 城通直链里的 limit=2 表示该直链允许 2 个并发连接。
// aria2 的 20 个线程如果每个线程都重新解析一次，就会产生 20 次上游请求；
// 默认把每条直链复用 limit 次（通常 2 次），可把上游请求数减半。
const DOWNLOAD_URL_REUSE = !/^(0|false|no)$/i.test(
	(process.env.DOWNLOAD_URL_REUSE || '1').trim()
);
const DOWNLOAD_URL_CACHE_TTL_MS = Math.max(
	1000,
	Number(process.env.DOWNLOAD_URL_CACHE_TTL_MS) || 15000
);
const DOWNLOAD_URL_MAX_USES = Math.max(
	1,
	Number(process.env.DOWNLOAD_URL_MAX_USES) || 4
);

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

// 网络错误、上游 5xx、上游返回非 JSON（常见于风控/限流页面）等可重试错误
class UpstreamNetworkError extends Error {
	status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = 'UpstreamNetworkError';
		this.status = status;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// 简单信号量：限制同时发往城通上游的请求数量，避免 20 线程瞬间打满触发风控
class Semaphore {
	private active = 0;
	private queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
	}

	release(): void {
		const next = this.queue.shift();
		if (next) {
			// 直接把槽位交给下一个等待者，不再减少 active
			next();
			return;
		}
		this.active--;
	}
}

// 按 key 串行执行任务，用于把同一个文件的直链解析串行化，
// 避免 20 个 aria2 线程同时为同一个文件请求 20 次上游。
class KeyedMutex {
	private tails = new Map<string, Promise<void>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(task, task);
		const tail = result.then(
			() => undefined,
			() => undefined
		);
		this.tails.set(key, tail);
		tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return result;
	}
}

const downloadUrlMutex = new KeyedMutex();

const upstreamSemaphore = new Semaphore(UPSTREAM_MAX_CONCURRENCY);

async function withUpstreamSlot<T>(task: () => Promise<T>): Promise<T> {
	await upstreamSemaphore.acquire();
	try {
		return await task();
	} finally {
		upstreamSemaphore.release();
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableUpstreamError(error: unknown): boolean {
	if (error instanceof UpstreamNetworkError) return true;

	const message = String((error as Error)?.message || '').toLowerCase();
	return /fetch failed|network|socket|econnreset|etimedout|eai_again|other side closed|terminated|aborted|timeout/.test(
		message
	);
}

// ======================== v4 客户端接口实现 (免费账号免会员) ========================
class CTFileV4API {
	private async post<T>(
		endpoint: string,
		payload: Record<string, unknown>,
		accessToken?: string,
		options: { retries?: number; timeoutMs?: number } = {}
	): Promise<T> {
		const retries = options.retries ?? UPSTREAM_RETRY_TIMES;
		const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
		let lastError: unknown;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await withUpstreamSlot(() =>
					this.postOnce<T>(endpoint, payload, accessToken, timeoutMs)
				);
			} catch (error: any) {
				lastError = error;
				if (attempt >= retries || !isRetryableUpstreamError(error)) {
					throw error;
				}
				const delay =
					UPSTREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) +
					Math.floor(Math.random() * 100);
				console.warn(
					`[upstream] ${endpoint} 第 ${attempt + 1} 次请求失败: ${error.message}；${delay}ms 后重试...`
				);
				await sleep(delay);
			}
		}

		throw lastError;
	}

	private async postOnce<T>(
		endpoint: string,
		payload: Record<string, unknown>,
		accessToken: string | undefined,
		timeoutMs: number
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
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error: any) {
			throw new UpstreamNetworkError(`无法连接上游 API ${url}: ${error.message}`);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error: any) {
			throw new UpstreamNetworkError(
				`读取上游响应失败 (HTTP ${response.status}): ${error.message}`,
				response.status
			);
		}

		// 429/5xx 通常是临时限流或上游故障，交给外层重试
		if (isRetryableStatus(response.status)) {
			throw new UpstreamNetworkError(
				`上游返回 HTTP ${response.status}: ${text.slice(0, 200)}`,
				response.status
			);
		}

		let data: any;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			// 上游被风控时经常返回 HTML 或空响应，这类错误也应重试
			throw new UpstreamNetworkError(
				`上游返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`,
				response.status
			);
		}

		if (data && typeof data.code !== 'undefined' && data.code !== 200) {
			const code = Number(data.code);
			// 上游业务码为 429，或提示“频繁/稍后再试”时，按可重试的限流处理
			if (code === 429 || /频繁|稍后|限流|too many|rate limit/i.test(String(data.message || ''))) {
				throw new UpstreamNetworkError(
					data.message || `上游限流 (code=${data.code})`,
					code === 429 ? 429 : 503
				);
			}
			throw new UpstreamError(code, data.message || `上游返回错误码 ${data.code}`);
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
		const doRefresh = async (rotate: boolean) => {
			const res = await this.post<{
				code: number;
				data?: any;
				token?: string;
				refresh_token?: string;
				expires_in?: number;
			}>(
				'/v4/user/auth/refresh-token',
				{
					refresh_token: refreshToken,
					...(rotate ? { rotate_token: true } : {}),
				},
				undefined,
				// 不轮换的刷新是幂等的，可以安全重试；
				// rotate_token=true 可能已经在上游完成轮换，重试反而会失败，因此不重试。
				{ retries: rotate ? 0 : UPSTREAM_RETRY_TIMES }
			);

			const token =
				res.token ||
				res.data?.token ||
				res.data?.access_token ||
				res.data?.accessToken;
			if (!token) {
				throw new Error('刷新 Token 失败，上游未返回有效 access_token');
			}

			return {
				token,
				refresh_token:
					res.refresh_token || res.data?.refresh_token || res.data?.refreshToken || refreshToken,
				expires_in: res.expires_in || res.data?.expires_in || 900,
			};
		};

		// 优先尝试「不轮换」刷新，这样环境变量里的 refresh_token 可以一直复用；
		// 如果上游要求必须轮换（返回错误），再退回到 rotate_token=true。
		try {
			return await doRefresh(false);
		} catch (error) {
			console.warn('不轮换刷新失败，改用 rotate_token=true 重试:', (error as Error).message);
			return await doRefresh(true);
		}
	}

	// 验证一个 access_token 是否有效（调用轻量的用户信息接口）
	async verifyAccessToken(accessToken: string): Promise<boolean> {
		try {
			const res = await this.post<{ code: number }>(
				'/v4/user/profile/info',
				{},
				accessToken
			);
			return res.code === 200;
		} catch {
			return false;
		}
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

	// 创建下载授权并换取真实直链
	// 正确的官方客户端调用链（2026-11 实测可用）：
	//   1. POST /v4/public/browser/create-download-auth { xtlink, ids: "f1420878136" }
	//        -> data.download_signature
	//   2. (可选) POST /v4/file/browse/download-audit 上报审计
	//   3. POST /v4/public/browser/fetch-url
	//        { file_id: "1420878136", download_sign: <sig>, xtlink, carrier: 0 }
	//        -> data.download_url  (真正的直链)
	async download(
		xtlink: string,
		fileId: string,
		accessToken: string
	): Promise<{ code: number; download_url: string }> {
		const originalId = fileId.trim();
		const normalizedId = /^[fd]\d+$/.test(originalId) ? originalId.slice(1) : originalId;
		// create-download-auth 的 ids 字段需要带 f/d 前缀的原始 fid
		const prefixedId = /^[fd]/.test(originalId) ? originalId : `f${originalId}`;

		const bareXtlink = xtlink.startsWith('ctfile://') ? xtlink.slice('ctfile://'.length) : xtlink;

		console.log(`[download] 正在获取下载签名: xtlink=${bareXtlink.slice(0, 15)}..., fileId=${prefixedId}`);

		// 1. 获取下载签名
		const authResult = await this.post<{
			code: number;
			data?: {
				download_signature?: string;
				audit?: { url?: string; params?: Record<string, unknown> };
			};
			download_signature?: string;
		}>(
			'/v4/public/browser/create-download-auth',
			{
				xtlink: bareXtlink,
				ids: prefixedId,
			},
			accessToken
		);

		const signature =
			authResult.data?.download_signature || authResult.download_signature;
		if (!signature) {
			throw new UpstreamError(
				502,
				'未能获取 download_signature 下载签名，可能是链接失效、账号无下载权限或上游限流'
			);
		}

		// 2. 上报下载审计（可选，失败不影响后续；不重试以免拖慢下载）
		const audit = authResult.data?.audit;
		if (audit?.url && audit?.params) {
			try {
				await this.post(audit.url, audit.params, accessToken, { retries: 0 });
			} catch (err: any) {
				console.warn('[download] download-audit 上报失败（忽略）:', err.message);
			}
		}

		// 3. 换取真实直链：/v4/public/browser/fetch-url
		console.log(`[download] 正在换取直链...`);
		const directResult = await this.post<{
			code: number;
			download_url?: string;
			data?: { download_url?: string; url?: string };
		}>(
			'/v4/public/browser/fetch-url',
			{
				file_id: normalizedId,
				download_sign: signature,
				xtlink: bareXtlink,
				carrier: CARRIER,
			},
			accessToken
		);

		const downloadUrl =
			directResult.data?.download_url ||
			directResult.download_url ||
			directResult.data?.url;

		if (!downloadUrl) {
			console.error('[download] fetch-url 未返回直链，响应内容:', directResult);
			throw new UpstreamError(502, '上游接口未返回 download_url 直链');
		}

		console.log(`[download] 成功解析直链: ${downloadUrl.slice(0, 60)}...`);

		return {
			code: 200,
			download_url: downloadUrl,
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

// 每个账号独立的刷新锁，避免并发请求时因 rotate_token 导致 refresh_token 互相失效
const refreshInFlight = new Map<string, Promise<string>>();

async function refreshAccountToken(account: V4Account): Promise<string> {
	if (!account.refreshToken) {
		if (account.accessToken) return account.accessToken;
		throw new Error(`账号 ${account.id} 无有效的 access_token 或 refresh_token`);
	}

	const existing = refreshInFlight.get(account.id);
	if (existing) return existing;

	const task = (async () => {
		console.log(`正在为账号 ${account.id} 自动刷新 access_token...`);
		const refreshResult = await v4Api.refreshToken(account.refreshToken!);
		account.accessToken = refreshResult.token;
		account.accessTokenExpiresAt = Date.now() + (refreshResult.expires_in || 900) * 1000;
		if (refreshResult.refresh_token) {
			account.refreshToken = refreshResult.refresh_token;
		}
		saveTokensFile();
		return account.accessToken;
	})().finally(() => {
		refreshInFlight.delete(account.id);
	});

	refreshInFlight.set(account.id, task);
	return task;
}

function nextV4Account(): V4Account {
	if (V4_ACCOUNTS.length === 0) {
		throw new Error(
			'未配置可用账号。你可以访问服务主页上的「/qr」页面，使用城通网盘手机 App 扫码登录（无需会员）；或者在环境变量中配置 REFRESH_TOKENS。'
		);
	}

	const index = Math.abs(appState.tokenIndex) % V4_ACCOUNTS.length;
	const account = V4_ACCOUNTS[index];
	appState.tokenIndex = (index + 1) % V4_ACCOUNTS.length;
	saveState();
	return account;
}

async function getV4AccessTokenForAccount(account: V4Account): Promise<string> {
	const now = Date.now();
	// 如果已有有效 access_token（且距离过期还有 60 秒以上），直接使用
	if (account.accessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt > now + 60000) {
		return account.accessToken;
	}

	try {
		return await refreshAccountToken(account);
	} catch (error: any) {
		console.error(`账号 ${account.id} 刷新 Token 失败:`, error.message);
		// 如果当前账号已失效但仍有 accessToken，尝试降级使用原有 accessToken
		if (account.accessToken) return account.accessToken;
		throw error;
	}
}

async function getV4AccessToken(): Promise<string> {
	return getV4AccessTokenForAccount(nextV4Account());
}

// 某些错误换个账号就能成功（token 过期/被风控/无下载权限），
// 这类错误在 /download 里自动轮换账号重试，避免 aria2 的一个线程直接失败。
function isAccountRetryable(error: unknown): boolean {
	if (error instanceof UpstreamError) {
		// 400/404 通常是链接或文件本身无效，换账号也没用
		return error.code !== 400 && error.code !== 404;
	}
	return true;
}

async function resolveV4DownloadUrl(
	xtlink: string,
	fileId: string,
	customToken?: string
): Promise<string> {
	if (customToken) {
		const result = await v4Api.download(xtlink, fileId, customToken);
		return result.download_url;
	}

	const totalAccounts = V4_ACCOUNTS.length;
	if (totalAccounts === 0) {
		throw new Error(
			'未配置可用账号。你可以访问服务主页上的「/qr」页面，使用城通网盘手机 App 扫码登录（无需会员）；或者在环境变量中配置 REFRESH_TOKENS。'
		);
	}

	const attempts = Math.min(DOWNLOAD_ACCOUNT_ATTEMPTS, totalAccounts);
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const account = nextV4Account();
		try {
			const token = await getV4AccessTokenForAccount(account);
			const result = await v4Api.download(xtlink, fileId, token);
			if (!result.download_url) {
				throw new UpstreamError(502, '上游接口未返回 download_url 直链');
			}
			return result.download_url;
		} catch (error: any) {
			lastError = error;
			console.warn(
				`[download] 账号 ${account.id} 解析直链失败 (${attempt + 1}/${attempts}): ${error.message}`
			);
			if (attempt >= attempts - 1 || !isAccountRetryable(error)) {
				throw error;
			}
			// 换下一个账号前稍作退避，避免在限流时继续加压
			await sleep(200 * (attempt + 1) + Math.floor(Math.random() * 100));
		}
	}

	throw lastError;
}

interface PooledDownloadUrl {
	url: string;
	remainingUses: number;
	expiresAt: number;
}

// 同一个 xtlink + file_id 的直链池
const downloadUrlPool = new Map<string, PooledDownloadUrl[]>();

function parseUrlUseLimit(downloadUrl: string): number {
	try {
		const limit = Number(new URL(downloadUrl).searchParams.get('limit'));
		if (!Number.isFinite(limit) || limit < 1) return 1;
		return Math.min(Math.floor(limit), DOWNLOAD_URL_MAX_USES);
	} catch {
		return 1;
	}
}

// /download 专用：优先复用还没达到并发上限的直链，
// 同一个文件同时只有一个请求在向上游解析，避免 20 线程造成 20 次解析。
async function acquireV4DownloadUrl(
	xtlink: string,
	fileId: string,
	customToken?: string
): Promise<string> {
	// 调用方显式指定 token 时不使用共享池，避免把其他账号的直链返回给它
	if (customToken || !DOWNLOAD_URL_REUSE) {
		return resolveV4DownloadUrl(xtlink, fileId, customToken);
	}

	// f123 和 123 指向同一个文件，统一成不带前缀的形式作为缓存 key
	const normalizedFileId = /^[fd]\d+$/.test(fileId.trim()) ? fileId.trim().slice(1) : fileId.trim();
	const key = `${xtlink}|${normalizedFileId}`;
	return downloadUrlMutex.run(key, async () => {
		const now = Date.now();
		const pool = (downloadUrlPool.get(key) || []).filter(
			(entry) => entry.expiresAt > now && entry.remainingUses > 0
		);

		const reusable = pool.shift();
		if (reusable) {
			reusable.remainingUses--;
			if (reusable.remainingUses > 0) {
				pool.unshift(reusable);
			}
			downloadUrlPool.set(key, pool);
			console.log(
				`[download] 复用直链（剩余 ${reusable.remainingUses} 次）: ${reusable.url.slice(0, 60)}...`
			);
			return reusable.url;
		}

		const url = await resolveV4DownloadUrl(xtlink, fileId);
		const maxUses = parseUrlUseLimit(url);
		if (maxUses > 1) {
			pool.push({
				url,
				remainingUses: maxUses - 1,
				expiresAt: Date.now() + DOWNLOAD_URL_CACHE_TTL_MS,
			});
			downloadUrlPool.set(key, pool);
		} else {
			downloadUrlPool.delete(key);
		}
		return url;
	});
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
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 22px 0 14px;
      color: #9ca3af;
      font-size: 12px;
    }
    .divider::before, .divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 10px;
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
      min-height: 60px;
    }
    textarea:focus { outline: none; border-color: #2563eb; }
    .btn-secondary {
      background: #f3f4f6;
      color: #374151;
      margin-top: 8px;
      width: 100%;
    }
    .btn-secondary:hover { background: #e5e7eb; }
    .hint {
      font-size: 12px;
      color: #9ca3af;
      text-align: left;
      line-height: 1.6;
      margin-top: 8px;
    }
    .hint code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
    .account-list {
      margin-top: 14px;
      text-align: left;
      font-size: 13px;
    }
    .account-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border: 1px solid #eef0f3;
      border-radius: 8px;
      margin-bottom: 6px;
      background: #fafafa;
    }
    .account-item .meta { color: #6b7280; font-size: 12px; }
    .account-item .del {
      color: #dc2626;
      cursor: pointer;
      font-size: 12px;
      background: none;
      border: none;
      padding: 4px 6px;
    }
    .account-item .del:hover { text-decoration: underline; }
    details.manual { margin-top: 4px; text-align: left; }
    details.manual summary {
      cursor: pointer;
      font-size: 13px;
      color: #2563eb;
      list-style: none;
      user-select: none;
      padding: 6px 0;
    }
    details.manual summary::-webkit-details-marker { display: none; }
    details.manual summary:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">免费账号可用 · 无需会员</span>
    <h1>城通网盘账号登录</h1>
    <p class="desc">打开<strong>城通网盘手机 App</strong>，使用扫一扫扫描下方二维码完成授权。授权后系统将自动保存并在后台持久化自动续期。</p>
    <div class="qr-container" id="qrContainer">
      <span id="loadingText" style="color: #9ca3af; font-size: 13px;">正在生成二维码...</span>
      <img id="qrImg" style="display: none;" alt="二维码">
    </div>
    <div class="status" id="statusText">等待生成二维码...</div>
    <div>
      <button class="btn" id="refreshBtn" onclick="initQr()">刷新二维码</button>
    </div>

    <div class="divider">或手动添加 Token</div>
    <details class="manual">
      <summary>▸ 没有 App？点这里粘贴 refresh_token</summary>
      <textarea id="manualToken" placeholder="粘贴 refresh_token（或 access_token）"></textarea>
      <input id="manualUser" placeholder="备注名（可选）" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:13px;margin-top:8px;">
      <button class="btn btn-secondary" onclick="submitToken()">添加账号</button>
      <div class="hint" id="manualHint">
        获取方法：浏览器登录 <code>pan.ctfile.com</code> → 按 F12 → Application → Session Storage → 复制 <code>refresh_token</code> 的值。
      </div>
    </details>

    <div class="stats" id="accountsStats">加载账号状态中...</div>
    <div class="account-list" id="accountList"></div>
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

        const listEl = document.getElementById('accountList');
        if (data.count > 0 && data.accounts) {
          listEl.innerHTML = data.accounts.map(function (a) {
            var exp = a.hasAccessToken ? ('access_token 剩余 ' + a.expiresInSeconds + 's') : '待刷新';
            return '<div class="account-item"><span>' +
              (a.username ? a.username + ' ' : '') +
              '<span class="meta">#' + a.index + ' · ' + exp + '</span></span>' +
              '<button class="del" onclick="deleteAccount(' + a.index + ')">删除</button></div>';
          }).join('');
        } else {
          listEl.innerHTML = '';
        }
      } catch (e) {}
    }

    async function deleteAccount(index) {
      if (!confirm('确定要删除该账号吗？')) return;
      try {
        const res = await fetch('/auth/accounts/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: index })
        });
        const data = await res.json();
        if (data.code === 200) loadStats();
      } catch (e) { alert('删除失败: ' + e.message); }
    }

    async function submitToken() {
      const hint = document.getElementById('manualHint');
      const token = document.getElementById('manualToken').value.trim();
      const username = document.getElementById('manualUser').value.trim();
      if (!token) { hint.textContent = '请先粘贴 token'; hint.style.color = '#dc2626'; return; }
      hint.textContent = '正在验证并添加...';
      hint.style.color = '#6b7280';
      try {
        const res = await fetch('/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, username: username })
        });
        const data = await res.json();
        if (data.code === 200) {
          if (data.verified === false) {
            hint.textContent = '已保存，但验证失败: ' + (data.verifyError || 'token 可能无效');
            hint.style.color = '#d97706';
          } else {
            hint.textContent = '✅ 添加成功！当前账号数：' + data.count;
            hint.style.color = '#059669';
            document.getElementById('manualToken').value = '';
            document.getElementById('manualUser').value = '';
          }
          loadStats();
        } else {
          hint.textContent = '❌ ' + (data.error || '添加失败');
          hint.style.color = '#dc2626';
        }
      } catch (e) {
        hint.textContent = '❌ 请求失败: ' + e.message;
        hint.style.color = '#dc2626';
      }
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

// 读取请求体（支持 JSON / 表单 / 纯文本）
async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
	return new Promise((resolve) => {
		let raw = '';
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			const result: Record<string, string> = {};
			if (!raw) return resolve(result);
			try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object') {
					for (const [k, v] of Object.entries(parsed)) {
						result[k] = typeof v === 'string' ? v : String(v ?? '');
					}
					return resolve(result);
				}
			} catch {
				// 不是 JSON，继续尝试表单编码
			}
			try {
				const usp = new URLSearchParams(raw);
				for (const [k, v] of usp.entries()) result[k] = v;
			} catch {
				result.raw = raw.trim();
			}
			resolve(result);
		};

		req.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > 1024 * 64) {
				finish();
				req.destroy();
			}
		});
		req.on('end', finish);
		req.on('error', finish);
		// 兜底：3 秒后仍未结束则按已读取内容处理
		setTimeout(finish, 3000);
	});
}

// 将 token 加入账号池（去重 + 持久化），返回是否为新增
function addV4Account(input: {
	refreshToken?: string;
	accessToken?: string;
	expiresIn?: number;
	username?: string;
	id?: string;
}): { added: boolean; account: V4Account } {
	const refreshToken = input.refreshToken?.trim();
	const accessToken = input.accessToken?.trim();
	if (!refreshToken && !accessToken) {
		throw new Error('refresh_token 与 access_token 至少需要提供一个');
	}

	const exists = V4_ACCOUNTS.find(
		(a) =>
			(refreshToken && a.refreshToken === refreshToken) ||
			(accessToken && a.accessToken === accessToken)
	);
	if (exists) {
		// 已存在则更新
		if (refreshToken) exists.refreshToken = refreshToken;
		if (accessToken) {
			exists.accessToken = accessToken;
			exists.accessTokenExpiresAt = Date.now() + (input.expiresIn || 900) * 1000;
		}
		if (input.username) exists.username = input.username;
		saveTokensFile();
		return { added: false, account: exists };
	}

	const account: V4Account = {
		id: input.id || `manual-${V4_ACCOUNTS.length + 1}`,
		refreshToken,
		accessToken,
		accessTokenExpiresAt: accessToken ? Date.now() + (input.expiresIn || 900) * 1000 : 0,
		username: input.username,
	};
	V4_ACCOUNTS.push(account);
	saveTokensFile();
	return { added: true, account };
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

	const POST_PATHS = new Set(['/auth/token', '/auth/accounts/delete']);
	const postAllowed = req.method === 'POST' && POST_PATHS.has(pathname);
	if (req.method !== 'GET' && !postAllowed) {
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
						username: a.username,
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

		// 手动添加账号：POST /auth/token
		// 支持 body（JSON 或表单）或 query：
		//   token         —— 通用字段，自动判断是 refresh_token 还是 access_token
		//   refresh_token —— 明确指定 refresh_token
		//   access_token  —— 明确指定 access_token
		//   username / id / expires_in —— 可选
		if (pathname === '/auth/token' && req.method === 'POST') {
			const body = await readBody(req);
			const explicitRefresh =
				body.refresh_token || body.refreshToken || params.get('refresh_token') || '';
			const explicitAccess =
				body.access_token || body.accessToken || params.get('access_token') || '';
			const generic = body.token || params.get('token') || '';
			const username = body.username || params.get('username') || undefined;
			const expiresIn = Number(body.expires_in || params.get('expires_in') || 0) || undefined;
			const id = body.id || params.get('id') || undefined;

			const tryRefresh = async (rt: string) => {
				const r = await v4Api.refreshToken(rt);
				return r;
			};

			try {
				let verified: boolean | null = null;
				let verifyError: string | null = null;
				let usedAs = '';
				let added = false;
				let accountId = '';

				if (explicitRefresh) {
					// 明确是 refresh_token：尝试刷新验证
					try {
						const r = await tryRefresh(explicitRefresh);
						const res1 = addV4Account({
							refreshToken: r.refresh_token || explicitRefresh,
							accessToken: r.token,
							expiresIn: r.expires_in || expiresIn,
							username,
							id,
						});
						added = res1.added;
						accountId = res1.account.id;
						usedAs = 'refresh_token';
						verified = true;
					} catch (err: any) {
						verified = false;
						verifyError = err.message;
						const res1 = addV4Account({ refreshToken: explicitRefresh, username, id });
						added = res1.added;
						accountId = res1.account.id;
						usedAs = 'refresh_token';
					}
				} else if (explicitAccess) {
					const ok = await v4Api.verifyAccessToken(explicitAccess);
					if (!ok) throw new Error('access_token 无效或已过期');
					const res1 = addV4Account({
						accessToken: explicitAccess,
						expiresIn,
						username,
						id,
					});
					added = res1.added;
					accountId = res1.account.id;
					usedAs = 'access_token';
					verified = true;
				} else if (generic) {
					// 通用字段：先当作 refresh_token，失败再当作 access_token
					try {
						const r = await tryRefresh(generic);
						const res1 = addV4Account({
							refreshToken: r.refresh_token || generic,
							accessToken: r.token,
							expiresIn: r.expires_in || expiresIn,
							username,
							id,
						});
						added = res1.added;
						accountId = res1.account.id;
						usedAs = 'refresh_token';
						verified = true;
					} catch (refreshErr: any) {
						const ok = await v4Api.verifyAccessToken(generic);
						if (!ok) {
							throw new Error(
								`token 无效：作为 refresh_token 刷新失败（${refreshErr.message}），作为 access_token 也无法通过验证`
							);
						}
						const res1 = addV4Account({ accessToken: generic, expiresIn, username, id });
						added = res1.added;
						accountId = res1.account.id;
						usedAs = 'access_token';
						verified = true;
					}
				} else {
					throw new Error('请提供 token / refresh_token / access_token');
				}

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						code: 200,
						added,
						verified,
						verifyError,
						usedAs,
						count: V4_ACCOUNTS.length,
						accountId,
					})
				);
			} catch (err: any) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ code: 400, error: err.message }));
			}
			return;
		}

		// 删除账号：POST /auth/accounts/delete  body/query: index 或 id
		if (pathname === '/auth/accounts/delete' && req.method === 'POST') {
			const body = await readBody(req);
			const indexStr = body.index ?? params.get('index');
			const id = body.id || params.get('id');

			let removed = 0;
			if (indexStr !== undefined && indexStr !== null && indexStr !== '') {
				const idx = Number(indexStr);
				if (Number.isInteger(idx) && idx >= 0 && idx < V4_ACCOUNTS.length) {
					V4_ACCOUNTS.splice(idx, 1);
					removed = 1;
				}
			} else if (id) {
				const before = V4_ACCOUNTS.length;
				V4_ACCOUNTS = V4_ACCOUNTS.filter((a) => a.id !== id);
				removed = before - V4_ACCOUNTS.length;
			}

			saveTokensFile();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ code: 200, removed, count: V4_ACCOUNTS.length }));
			return;
		}

		const rawPasswordParam = params.get('password') || (req.headers['x-password'] as string) || '';
		const inputPassword = rawPasswordParam.trim().replace(/^["']|["']$/g, '').trim();
		const rawPasswordEnv = process.env.PASSWORD || '';
		const configuredPassword = rawPasswordEnv.trim().replace(/^["']|["']$/g, '').trim();

		if (pathname === '/login') {
			res.setHeader('Content-Type', 'application/json');
			if (!configuredPassword || inputPassword === configuredPassword) {
				res.writeHead(200);
				res.end('true');
				return;
			} else {
				res.writeHead(200);
				res.end('false');
				return;
			}
		}

		if (configuredPassword && inputPassword !== configuredPassword) {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ code: 403, error: 'Wrong Password' }));
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
				// v4 客户端协议模式：失败时自动换账号重试，同一文件的直链按 limit 复用
				const customToken = params.get('token') || params.get('session') || undefined;
				upstreamUrl = await acquireV4DownloadUrl(xtlink, file_id, customToken);
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
				const customToken = params.get('token') || params.get('session') || undefined;

				if (file_id.length > 0) {
					filesToDownload = file_id.map((key) => ({ key }));
				} else {
					const token = customToken || (await getV4AccessToken());
					filesToDownload = await v4Api.list(xtlink, token);
				}

				const results = await Promise.all(
					filesToDownload.map(async (file) => {
						if (!download) {
							return file;
						} else {
							const downloadUrl = await resolveV4DownloadUrl(
								xtlink!,
								file.key,
								customToken
							);
							return { ...file, downloadUrl };
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
		// aria2 只会在日志里显示 status=500/502，真正的原因必须看服务端日志。
		console.error(
			`[request] ${req.method} ${pathname} 处理失败: ${error?.message || error}`,
			error?.stack || ''
		);
		let status = 500;
		let retryAfter: string | undefined;
		if (error instanceof UpstreamNetworkError) {
			// 上游网络错误/限流：用 503 明确告知调用方可重试
			status = 503;
			retryAfter = '2';
		} else if (error instanceof UpstreamError) {
			status = 502;
		}

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (retryAfter) headers['Retry-After'] = retryAfter;
		res.writeHead(status, headers);
		res.end(JSON.stringify({ code: status, error: error.message }));
	}
}

function main(): void {
	// 1. 加载持久化状态与已保存的 token（.tokens.json 中的凭据是最新的，因为刷新会轮换 refresh_token）
	loadState();
	loadTokensFile();

	// 2. 加载环境变量中的 Tokens / RefreshTokens / Sessions
	// 注意：refresh_token 在每次刷新时会被轮换（rotate_token），因此持久化文件里的 token 永远比环境变量更新。
	// 一旦有过持久化记录，就忽略环境变量里的旧 token，避免加载已失效的初始 refresh_token。
	const refreshTokensEnv =
		process.env.REFRESH_TOKENS || process.env.TOKENS || process.env.WEB_TOKENS || '';
	if (refreshTokensEnv && V4_ACCOUNTS.length === 0) {
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
