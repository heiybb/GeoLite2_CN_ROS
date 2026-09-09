/**
 * 每日生成 CN/HK/SG address-list,写 R2,并对路由器提供 HTTP 服务。
 *
 * 一致性模型:**生成代 + 原子翻指针**。
 *   每次跑把文件写到 v/<gen>/...,全部成功之后才把 current.json 指向新的 gen。
 *   跑挂了就没人翻指针,路由器继续拿到上一代完整的列表 —— 绝不会 import 到
 *   一份半成品把 address-list 清空。旧的代顺带就是 diff 历史,想查"昨天为什么
 *   少了五千条"直接比两代的 .txt。
 */
import { build } from "./lib.js";

const MS_DL_PAGE = "https://www.microsoft.com/en-us/download/details.aspx?id=56519";
const MS_DL_BASE =
	"https://download.microsoft.com/download/7/1/d/71d86715-5596-4529-9b13-da13a5de5b63";
const SERVICE_TAG_RE = /https:\/\/[^"'\s]*ServiceTags_Public_\d{8}\.json/g;

const POINTER_KEY = "current.json";
const HISTORY_KEY = "history.json";
const HISTORY_MAX = 90;

function reqEnv(env, name) {
	const v = env[name];
	if (typeof v !== "string" || v.length === 0) throw new Error(`${name} 未配置`);
	return v;
}

function splitList(v) {
	return (v ?? "").split(/\s+/).filter(Boolean);
}

/** service tag 文件名带发布日期,每周变。先抓下载页,失败再按日期回溯。 */
async function resolveServiceTagUrl(log) {
	try {
		const res = await fetch(MS_DL_PAGE, { cf: { cacheTtl: 3600 } });
		if (res.ok) {
			const html = await res.text();
			const hits = [...html.matchAll(SERVICE_TAG_RE)].map((m) => m[0]);
			if (hits.length > 0) {
				hits.sort();
				const url = hits[hits.length - 1];
				log(`从下载页拿到: ${url}`);
				return url;
			}
		}
		log(`下载页没给出链接(HTTP ${res.status}),按日期回溯 ...`);
	} catch (e) {
		log(`抓下载页失败(${e.message}),按日期回溯 ...`);
	}
	const now = Date.now();
	for (let i = 0; i <= 20; i++) {
		const d = new Date(now - i * 86400000);
		const stamp =
			d.getUTCFullYear().toString() +
			String(d.getUTCMonth() + 1).padStart(2, "0") +
			String(d.getUTCDate()).padStart(2, "0");
		const url = `${MS_DL_BASE}/ServiceTags_Public_${stamp}.json`;
		const res = await fetch(url, { method: "HEAD" });
		if (res.ok) {
			log(`回溯命中 ${stamp}`);
			return url;
		}
	}
	throw new Error("拿不到 Azure service tags 的下载地址");
}

async function loadServiceTags(log) {
	const url = await resolveServiceTagUrl(log);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`下载 service tags 失败: HTTP ${res.status}`);
	const tags = await res.json();
	if (!tags || !Array.isArray(tags.values)) throw new Error("service tags 不是预期的 JSON 结构");
	return tags;
}

/**
 * IPinfo Lite 是 Content-Type: application/gzip 且**没有** Content-Encoding,
 * 也就是说 gzip 是载荷而不是传输编码,Workers 的自动解压不会碰它,必须自己解。
 * 而 strict_compression_checks 默认开着,所以流必须读到底,不能提前 break。
 */
async function openLiteStream(token, log) {
	const res = await fetch(`https://ipinfo.io/data/ipinfo_lite.csv.gz?token=${token}`);
	if (!res.ok) throw new Error(`下载 IPinfo Lite 失败: HTTP ${res.status}`);
	if (res.body === null) throw new Error("IPinfo Lite 响应没有 body");
	const enc = res.headers.get("content-encoding");
	log(
		`IPinfo Lite: content-type=${res.headers.get("content-type")} ` +
			`content-encoding=${enc ?? "(none)"} last-modified=${res.headers.get("last-modified")}`,
	);
	// 万一哪天他们改成用传输编码发,Workers 已经解过了,别再解一次。
	const needsGunzip = enc === null || enc === "identity";
	return {
		stream: needsGunzip ? res.body.pipeThrough(new DecompressionStream("gzip")) : res.body,
		sourceLastModified: res.headers.get("last-modified"),
		sourceEtag: res.headers.get("etag"),
	};
}

async function readJson(bucket, key) {
	const obj = await bucket.get(key);
	if (obj === null) return null;
	try {
		return await obj.json();
	} catch {
		return null;
	}
}

/** 只留最近 keep 代,其余删掉。R2 list 一次最多 1000 个 key,这里量级远低于此。 */
async function pruneGenerations(bucket, keepGens, log) {
	const listed = await bucket.list({ prefix: "v/", delimiter: "/" });
	const gens = (listed.delimitedPrefixes ?? [])
		.map((p) => p.slice(2).replace(/\/$/, ""))
		.filter(Boolean)
		.sort();
	const doomed = gens.filter((g) => !keepGens.has(g));
	if (doomed.length === 0) return 0;
	let removed = 0;
	for (const g of doomed) {
		const objs = await bucket.list({ prefix: `v/${g}/` });
		const keys = objs.objects.map((o) => o.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
			removed += keys.length;
		}
	}
	log(`清理了 ${doomed.length} 代旧数据 / ${removed} 个对象`);
	return removed;
}

async function runBuild(env, log) {
	const token = reqEnv(env, "IPINFO_TOKEN");
	const countries = splitList(env.COUNTRIES ?? "CN HK SG");
	const combinedName = env.COMBINED_NAME ?? "CN_HK_SG_CIDR_V4";
	const azureRegions = splitList(env.EXCLUDE_AZURE_REGIONS ?? "southeastasia");
	const excludeCidrs = splitList(env.EXCLUDE_CIDR);
	const keep = Number(env.KEEP_GENERATIONS ?? 14);

	// service tags 先拿:拿不到就整体放弃,绝不生成一份把出口区域包进去的列表。
	const serviceTags = azureRegions.length > 0 ? await loadServiceTags(log) : null;
	const { stream, sourceLastModified, sourceEtag } = await openLiteStream(token, log);

	const startedAt = new Date();
	const gen =
		startedAt.toISOString().slice(0, 19).replace(/[:-]/g, "").replace("T", "-") + "Z";
	log(`生成代: ${gen}`);

	const written = [];
	const { counts, stats } = await build({
		liteStream: stream,
		serviceTags,
		countries,
		combinedName,
		azureRegions,
		excludeCidrs,
		log,
		emit: async (name, f) => {
			// 写进本代目录。此刻还没人指向它,写坏了也影响不到路由器。
			await env.LISTS.put(`v/${gen}/${name}.txt`, f.txt, {
				httpMetadata: { contentType: "text/plain; charset=utf-8" },
			});
			await env.LISTS.put(`v/${gen}/${name}.rsc`, f.rsc, {
				httpMetadata: { contentType: "text/plain; charset=utf-8" },
			});
			written.push(name);
		},
	});

	const prev = await readJson(env.LISTS, POINTER_KEY);
	const countsObj = Object.fromEntries(counts);
	const delta = {};
	for (const [k, v] of counts) {
		const before = prev?.counts?.[k];
		delta[k] = typeof before === "number" ? v - before : null;
	}

	const pointer = {
		gen,
		generatedAt: startedAt.toISOString(),
		files: written,
		counts: countsObj,
		delta,
		cutAddrs: stats.cutAddrs,
		rows: stats.rows,
		skipped: stats.skipped,
		source: { lastModified: sourceLastModified, etag: sourceEtag },
		previousGen: prev?.gen ?? null,
	};

	// —— 翻指针。到这里为止路由器拿到的都还是上一代。 ——
	await env.LISTS.put(POINTER_KEY, JSON.stringify(pointer, null, 2), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	log(`指针已指向 ${gen}(上一代 ${prev?.gen ?? "无"})`);

	const history = (await readJson(env.LISTS, HISTORY_KEY)) ?? [];
	history.push({ gen, generatedAt: pointer.generatedAt, counts: countsObj, delta });
	while (history.length > HISTORY_MAX) history.shift();
	await env.LISTS.put(HISTORY_KEY, JSON.stringify(history), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});

	const keepGens = new Set(history.slice(-Math.max(1, keep)).map((h) => h.gen));
	keepGens.add(gen);
	if (prev?.gen) keepGens.add(prev.gen);
	await pruneGenerations(env.LISTS, keepGens, log);

	return pointer;
}

const ALLOWED = /^[A-Za-z0-9_]+\.(txt|rsc)$/;

export default {
	async scheduled(event, env, ctx) {
		const lines = [];
		const log = (m) => {
			lines.push(m);
			console.log(m);
		};
		try {
			const pointer = await runBuild(env, log);
			console.log(
				JSON.stringify({ event: "build_ok", gen: pointer.gen, counts: pointer.counts, delta: pointer.delta }),
			);
		} catch (e) {
			// 抛出去,让这次 cron 记为失败并进 observability;指针没翻,路由器不受影响。
			console.error(JSON.stringify({ event: "build_failed", error: e.message, log: lines }));
			throw e;
		}
	},

	async fetch(request, env, ctx) {
		try {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response("method not allowed\n", { status: 405 });
			}
			const url = new URL(request.url);
			const name = url.pathname.replace(/^\/+/, "");

			if (name === "" || name === "status" || name === "status.json") {
				const pointer = await readJson(env.LISTS, POINTER_KEY);
				if (pointer === null) return new Response("no build yet\n", { status: 503 });
				return Response.json(pointer, {
					headers: { "cache-control": "public, max-age=300" },
				});
			}
			if (name === "history" || name === "history.json") {
				const history = await readJson(env.LISTS, HISTORY_KEY);
				if (history === null) return new Response("no history yet\n", { status: 503 });
				return Response.json(history, {
					headers: { "cache-control": "public, max-age=300" },
				});
			}
			if (!ALLOWED.test(name)) return new Response("not found\n", { status: 404 });

			const pointer = await readJson(env.LISTS, POINTER_KEY);
			if (pointer === null) return new Response("no build yet\n", { status: 503 });

			const obj = await env.LISTS.get(`v/${pointer.gen}/${name}`);
			if (obj === null) return new Response("not found\n", { status: 404 });

			const headers = new Headers();
			obj.writeHttpMetadata(headers);
			headers.set("etag", obj.httpEtag);
			// 一天生成一次,给 1 小时缓存;换代后 etag 变,路由器能拿到新的。
			headers.set("cache-control", "public, max-age=3600");
			headers.set("x-list-generation", pointer.gen);
			if (request.method === "HEAD") return new Response(null, { headers });
			return new Response(obj.body, { headers });
		} catch (e) {
			console.error(JSON.stringify({ event: "fetch_failed", error: e.message }));
			return new Response("internal error\n", { status: 500 });
		}
	},
};
