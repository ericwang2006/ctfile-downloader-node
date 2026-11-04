import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 8787;
const STATE_FILE = path.join(process.cwd(), '.state.json');
const TOKEN_INDEX_KEY = 'tokenIndex';

// CTFile 已经停用了旧的 /p2 客户端接口（统一返回 410「请使用新客户端」），
// 新接口为 REST API v1: https://rest.ctfile.com/v1
// 认证方式也从 token 改为 session（在城通网盘后台「开放接口登录密钥管理」生成）。
const API_BASE = (process.env.CTFILE_API_BASE || 'https://rest.ctfile.com/v1').replace(/\/+$/, '');
const AUTH_FIELD = process.env.CTFILE_AUTH_FIELD || 'session';
// 如果 v1 要求 xtlink 带 ctfile:// 前缀，可设置 CTFILE_XTLINK_PREFIX=ctfile://
const XTLINK_PREFIX = process.env.CTFILE_XTLINK_PREFIX || '';
const CARRIER = process.env.CTFILE_CARRIER ? Number(process.env.CTFILE_CARRIER) : undefined;

interface AppState {
	tokenIndex: number;
}

interface DownloadInfo {
	key: string;
	name?: string;
}

let SESSIONS: string[] = [];
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

class UpstreamError extends Error {
	code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = 'UpstreamError';
		this.code = code;
	}
}

class CTFileAPI {
	private async post<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
		const url = `${API_BASE}${endpoint}`;
		const body = JSON.stringify(payload);

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'User-Agent': 'okhttp/4.9.2',
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body,
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

		if (!response.ok) {
			throw new Error(`上游 HTTP ${response.status}: ${data.message || text.slice(0, 200)}`);
		}

		// v1 接口即使参数/认证错误也返回 HTTP 200，错误信息在 code 中。
		if (data && typeof data.code !== 'undefined' && data.code !== 200) {
			throw new UpstreamError(Number(data.code), data.message || `上游返回错误码 ${data.code}`);
		}

		return data as T;
	}

	async list(
		xtlink: string,
		session?: string,
		folder_id?: string,
		basePath?: string
	): Promise<DownloadInfo[]> {
		const allFiles: DownloadInfo[] = [];
		const seenKeys = new Set<string>();
		let start = 0;

		// v1 列表接口支持 start 分页。部分部署可能一次返回全部，
		// 这里用 seenKeys 防止接口忽略 start 时陷入死循环。
		for (let page = 0; page < 1000; page++) {
			const reqResult = await this.post<{ results?: any[]; num?: number }>('/browser/file/list', {
				xtlink,
				folder_id: folder_id || 'd0',
				start,
				[AUTH_FIELD]: session,
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
		session?: string
	): Promise<{ code: number; download_url: string }> {
		const payload = (id: string) => ({
			xtlink,
			file_id: id,
			carrier: CARRIER,
			[AUTH_FIELD]: session,
		});

		// v1 文档中 file_id 不带 f 前缀，但列表接口返回的 key 通常是 f 开头。
		// 这里优先使用去掉前缀的 ID，失败后再用原始 key 重试。
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

function normalizeXtlink(xtlink: string): string {
	const bare = xtlink.startsWith('ctfile://') ? xtlink.slice('ctfile://'.length) : xtlink;
	return `${XTLINK_PREFIX}${bare}`;
}

function getSession(): string {
	if (Array.isArray(SESSIONS) && SESSIONS.length > 0) {
		// .state.json 里保存的下标可能超过当前 session 数量，先取模避免拿到 undefined。
		const index = Math.abs(appState.tokenIndex) % SESSIONS.length;
		const session = SESSIONS[index];
		appState.tokenIndex = (index + 1) % SESSIONS.length;
		saveState();
		return session;
	}
	throw new Error(
		'未配置可用的 session。旧的 p2 token 已被城通停用，请在城通网盘后台「开放接口登录密钥管理」生成 session，并通过 SESSIONS 环境变量配置（多个用逗号分隔）。'
	);
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
					apiBase: API_BASE,
					authField: AUTH_FIELD,
					sessionsConfigured: SESSIONS.length,
				})
			);
			return;
		}

		const password = params.get('password');
		const PASSWORD = process.env.PASSWORD;

		if (pathname === '/login') {
			if (!PASSWORD) {
				res.writeHead(200);
				res.end('true');
				return;
			}
			if (password === PASSWORD) {
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

		const paramsSession = params.get('session') || params.get('token');
		let session: string;

		if (paramsSession) {
			session = paramsSession;
		} else {
			session = getSession();
		}

		const api = new CTFileAPI();

		if (pathname === '/download') {
			let xtlink = params.get('xtlink');
			const file_id = params.get('file_id');

			if (!xtlink || !file_id) {
				res.writeHead(400);
				res.end('Missing required parameters');
				return;
			}

			xtlink = normalizeXtlink(xtlink);
			const downloadResult = await api.download(xtlink, file_id, session);
			const upstreamUrl = downloadResult.download_url;

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
			if (file_id.length > 0) {
				filesToDownload = file_id.map((key) => ({ key }));
			} else {
				filesToDownload = await api.list(xtlink, session);
			}

			const results = await Promise.all(
				filesToDownload.map(async (file) => {
					if (!download) {
						return file;
					} else {
						const dl = await api.download(xtlink!, file.key, session);
						return { ...file, downloadUrl: dl.download_url };
					}
				})
			);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(results));
			return;
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
	// SESSIONS 为新接口使用的 session；TOKENS 仅作为旧配置名的兼容入口。
	const sessionsEnv = process.env.SESSIONS || process.env.TOKENS || '';
	if (process.env.TOKENS && !process.env.SESSIONS) {
		console.warn(
			'TOKENS 是旧的配置名。如果里面还是旧的 p2 token，请改用城通后台生成的 v1 session 并设置 SESSIONS。'
		);
	}
	if (sessionsEnv) {
		SESSIONS = sessionsEnv
			.split(',')
			.map((session) => session.trim())
			.filter(Boolean);
	}
	if (SESSIONS.length === 0) {
		console.warn(
			'未配置 SESSIONS。旧的 p2 token 已失效，请在城通网盘后台「开放接口登录密钥管理」生成 session 后设置 SESSIONS。'
		);
	}

	// Load state from file
	loadState();

	const server = http.createServer(handleRequest);

	// 从环境变量获取 HOST，默认为 localhost
	const host = process.env.HOST || '0.0.0.0';

	server.listen(Number(PORT), host, () => {
		console.log(`Server is running on http://${host}:${PORT}`);
		console.log(`Upstream API: ${API_BASE}`);
		console.log(`Auth field: ${AUTH_FIELD}`);
		console.log(`Sessions configured: ${SESSIONS.length}`);
		console.log(`State file location: ${STATE_FILE}`);
	});
}

main();
