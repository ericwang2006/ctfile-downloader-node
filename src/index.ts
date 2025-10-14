import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

const PORT = process.env.PORT || 8787;
const STATE_FILE = path.join(process.cwd(), '.state.json');
const TOKEN_INDEX_KEY = 'tokenIndex';

interface AppState {
	tokenIndex: number;
}

let TOKENS: string[] = [];
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

class CTFileAPI {
	private headers: Record<string, string>;

	constructor() {
		this.headers = {
			'User-Agent': 'okhttp/4.9.2',
			'Content-Type': 'application/json',
		};
	}

	private async post<T>(endpoint: string, payload: any): Promise<T> {
		const url = `https://rest.ctfile.com${endpoint}`;
		
		return new Promise((resolve, reject) => {
			const postData = JSON.stringify(payload);
			
			const options = new URL(url);
			
			const req = https.request(
				{
					hostname: options.hostname,
					path: options.pathname + options.search,
					method: 'POST',
					headers: {
						...this.headers,
						'Content-Length': Buffer.byteLength(postData),
					},
				},
				(res: any) => {
					let data = '';
					res.on('data', (chunk: string) => (data += chunk));
					res.on('end', () => {
						if (res.statusCode !== 200) {
							reject(new Error(`Upstream error: ${res.statusCode}`));
						} else {
							try {
								resolve(JSON.parse(data));
							} catch (e) {
								reject(e);
							}
						}
					});
				}
			);

			req.on('error', reject);
			req.write(postData);
			req.end();
		});
	}

	async list(
		xtlink: string,
		token?: string,
		folder_id?: string,
		basePath?: string
	): Promise<Array<{ key: string; name: string }>> {
		const reqResult = await this.post<{ results: any[] }>('/p2/browser/file/list', {
			xtlink,
			token,
			folder_id,
			reload: false,
		});
		console.log(reqResult);
		const items = reqResult.results;
		const allFiles = [];
		for (const item of items) {
			const currentName = basePath ? `${basePath}/${item.name}` : item.name;
			if (item.icon === 'folder') {
				const subFiles = await this.list(xtlink, token, item.key, currentName);
				allFiles.push(...subFiles);
			} else {
				allFiles.push({
					key: item.key,
					name: currentName,
				});
			}
		}
		return allFiles;
	}

	async download(
		xtlink: string,
		file_id: string,
		token?: string
	): Promise<{ code: number; download_url: string }> {
		return this.post('/p2/browser/file/fetch_url', { xtlink, file_id, token });
	}
}

function processXtlink(xtlink: string): string {
	return xtlink.startsWith('ctfile://') ? xtlink : 'ctfile://' + xtlink;
}

function getToken(): string {
	if (Array.isArray(TOKENS) && TOKENS.length > 0) {
		const token = TOKENS[appState.tokenIndex];
		appState.tokenIndex = (appState.tokenIndex + 1) % TOKENS.length;
		saveState();
		return token;
	}
	throw new Error('No Token Found');
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	const url = new URL(req.url || '', `http://${req.headers.host}`);
	const params = url.searchParams;
	const path = url.pathname;

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
		if (path === '/meow') {
			res.writeHead(200);
			res.end('Meow!');
			return;
		}

		const password = params.get('password');
		const PASSWORD = process.env.PASSWORD;

		if (path === '/login') {
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

		const paramsToken = params.get('token');
		let token: string;

		if (paramsToken) {
			token = paramsToken;
		} else {
			token = getToken();
		}

		const api = new CTFileAPI();

		if (path === '/download') {
			let xtlink = params.get('xtlink');
			const file_id = params.get('file_id');

			if (!xtlink || !file_id) {
				res.writeHead(400);
				res.end('Missing required parameters');
				return;
			}

			xtlink = processXtlink(xtlink);
			const downloadResult = await api.download(xtlink, file_id, token);
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

		if (path === '/download_info') {
			let xtlink = params.get('xtlink');
			const download = params.get('download') === 'true';
			const file_id = params.getAll('file_id');

			if (!xtlink) {
				res.writeHead(400);
				res.end('Missing "xtlink" parameter');
				return;
			}

			xtlink = processXtlink(xtlink);

			let filesToDownload;
			if (file_id.length > 0) {
				filesToDownload = file_id.map((key) => ({ key }));
			} else {
				const listResult = await api.list(xtlink, token);
				filesToDownload = listResult.map((f) => ({ key: f.key, name: f.name }));
			}

			const results = await Promise.all(
				filesToDownload.map(async (file) => {
					if (!download) {
						return file;
					} else {
						const dl = await api.download(xtlink!, file.key!, token);
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
		res.writeHead(500);
		res.end(`Internal Server Error: ${error.message}`);
	}
}

function main(): void {
	// Load environment variables
	const tokensEnv = process.env.TOKENS || '';
	if (tokensEnv) {
		TOKENS = tokensEnv.split(',').map((token) => token.trim());
	}

	// Load state from file
	loadState();

	const server = http.createServer(handleRequest);

	// 从环境变量获取 HOST，默认为 localhost
	const host = process.env.HOST || '0.0.0.0';

	server.listen(Number(PORT), host, () => {
		console.log(`Server is running on http://${host}:${PORT}`);
		console.log(`State file location: ${STATE_FILE}`);
	});
}

main();