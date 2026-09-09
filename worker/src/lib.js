/**
 * IPinfo Lite -> RouterOS address-list,纯逻辑部分。
 *
 * 不引用任何 Workers 专有 API,只用 Web Streams,所以能在 node 下直接跑,
 * 拿输出和 generate.py 做逐字节对比。
 *
 * IPv4 全程用「无符号整数闭区间 [start, end]」表示。**不要用位运算**:
 * JS 的 <<、&、| 会把操作数强转成 int32,`128 << 24` 是负数,
 * `start & -start` 在 start >= 2^31 时结果也是错的。下面一律用算术。
 */

const K8 = 256;
const K16 = 65536;
const K24 = 16777216;
const K32 = 4294967296;

export function ipToInt(ip) {
	const p = ip.split(".");
	if (p.length !== 4) throw new Error(`bad ipv4: ${ip}`);
	const a = +p[0], b = +p[1], c = +p[2], d = +p[3];
	if (!(a >= 0 && a < 256 && b >= 0 && b < 256 && c >= 0 && c < 256 && d >= 0 && d < 256))
		throw new Error(`bad ipv4: ${ip}`);
	return a * K24 + b * K16 + c * K8 + d;
}

export function intToIp(n) {
	return (
		Math.floor(n / K24) +
		"." +
		(Math.floor(n / K16) % K8) +
		"." +
		(Math.floor(n / K8) % K8) +
		"." +
		(n % K8)
	);
}

/** "a.b.c.d/p" 或裸 "a.b.c.d" -> [start, end]。IPinfo 的 network 列两种都有。 */
export function netToInterval(net) {
	const slash = net.indexOf("/");
	if (slash < 0) {
		const s = ipToInt(net);
		return [s, s];
	}
	const s = ipToInt(net.slice(0, slash));
	const pfx = +net.slice(slash + 1);
	if (!(pfx >= 0 && pfx <= 32)) throw new Error(`bad prefix: ${net}`);
	return [s, s + Math.pow(2, 32 - pfx) - 1];
}

/**
 * 排序 + 合并重叠与相邻区间。与 generate.py 的 merge() 同算法。
 *
 * 注意:**就地排序,会重排入参**。省掉一份 slice() 拷贝,在 9 万元组这个量级
 * 上是几 MB 的差别。调用方不得在此之后依赖入参顺序。
 */
export function merge(intervals) {
	if (intervals.length === 0) return [];
	const a = intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out = [a[0].slice()];
	for (let i = 1; i < a.length; i++) {
		const [s, e] = a[i];
		const last = out[out.length - 1];
		if (s <= last[1] + 1) {
			if (e > last[1]) last[1] = e;
		} else {
			out.push([s, e]);
		}
	}
	return out;
}

/** 区间集合减法。base 与 cut 都必须已 merge。线性一趟。 */
export function subtract(base, cut) {
	if (cut.length === 0) return base.map((x) => x.slice());
	const out = [];
	let j = 0;
	for (const [s, e] of base) {
		while (j < cut.length && cut[j][1] < s) j++;
		let k = j;
		let cur = s;
		while (k < cut.length && cut[k][0] <= e) {
			const [cs, ce] = cut[k];
			if (cs > cur) out.push([cur, cs - 1]);
			if (ce + 1 > cur) cur = ce + 1;
			if (cur > e) break;
			k++;
		}
		if (cur <= e) out.push([cur, e]);
	}
	return out;
}

/** 两个已 merge 的集合是否相交;相交则返回第一对证据。 */
export function intersects(a, b) {
	let i = 0, j = 0;
	while (i < a.length && j < b.length) {
		if (a[i][1] < b[j][0]) i++;
		else if (b[j][1] < a[i][0]) j++;
		else return [a[i], b[j]];
	}
	return null;
}

export function countAddrs(intervals) {
	let n = 0;
	for (const [s, e] of intervals) n += e - s + 1;
	return n;
}

/** 能整除 x 的最大 2 的幂(即 x 的对齐粒度)。位运算在 >= 2^31 时不可靠,用算术。 */
function alignment(x) {
	if (x === 0) return K32;
	let size = 1;
	while (x % (size * 2) === 0) size *= 2;
	return size;
}

/** 区间 -> 最小 CIDR 集合。等价于 python 的 summarize_address_range。 */
export function intervalToCidrs(start, end, out) {
	let s = start;
	while (s <= end) {
		let size = alignment(s);
		const remaining = end - s + 1;
		while (size > remaining) size /= 2;
		const pfx = 32 - Math.round(Math.log2(size));
		out.push(intToIp(s) + "/" + pfx);
		s += size;
	}
	return out;
}

export function toCidrs(intervals) {
	const out = [];
	for (const [s, e] of intervals) intervalToCidrs(s, e, out);
	return out;
}

/**
 * 按行拆一个字节流。TextDecoder 用 stream 模式,所以多字节字符跨 chunk 也安全。
 * 必须把流读到底 —— Workers 的 strict_compression_checks 默认开启,
 * DecompressionStream 没读完就关会抛错。
 */
export async function* streamLines(readable) {
	const reader = readable.getReader();
	const decoder = new TextDecoder("utf-8");
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			yield buf.slice(0, nl);
			buf = buf.slice(nl + 1);
		}
	}
	buf += decoder.decode();
	if (buf.length > 0) yield buf;
}

/**
 * 拆一行 IPinfo Lite。国家名可能带逗号并加引号(如 "Korea, Republic of"),
 * 会把后面的列挤位,所以先按 country_code 的形状校验,不合格才走带引号的慢路径。
 * 列: network,country,country_code,continent,continent_code,asn,as_name,as_domain
 */
export function parseRow(line) {
	const f = line.split(",");
	if (f.length >= 6 && f[2].length === 2 && f[2] === f[2].toUpperCase() && /^[A-Z]{2}$/.test(f[2])) {
		return { network: f[0], cc: f[2], asn: f[5] };
	}
	const g = splitCsv(line);
	if (g.length < 6) return null;
	return { network: g[0], cc: g[2], asn: g[5] };
}

function splitCsv(line) {
	const out = [];
	let cur = "";
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			if (ch === '"') {
				if (line[i + 1] === '"') { cur += '"'; i++; }
				else q = false;
			} else cur += ch;
		} else if (ch === '"') q = true;
		else if (ch === ",") { out.push(cur); cur = ""; }
		else cur += ch;
	}
	out.push(cur);
	return out;
}

/**
 * 扫整个 IPinfo Lite 流,按 country_code 收区间。
 * onProgress 每 progressEvery 行回调一次,长任务要有进度探针。
 */
export async function readLite(readable, wanted, { onProgress, progressEvery = 500000 } = {}) {
	const perCc = new Map(wanted.map((cc) => [cc, []]));
	let rows = 0;
	let skipped = 0;
	let sawHeader = false;
	for await (const line of streamLines(readable)) {
		if (!sawHeader) {
			sawHeader = true;
			if (!line.includes("country_code")) {
				throw new Error(`意外的表头,IPinfo Lite 格式可能变了: ${line.slice(0, 120)}`);
			}
			continue;
		}
		if (line.length === 0) continue;
		rows++;
		if (onProgress && rows % progressEvery === 0) onProgress(rows);
		const r = parseRow(line);
		if (r === null) { skipped++; continue; }
		const bucket = perCc.get(r.cc);
		if (bucket === undefined) continue;
		if (r.network.indexOf(":") >= 0) continue;
		try {
			bucket.push(netToInterval(r.network));
		} catch {
			skipped++;
		}
	}
	return { perCc, rows, skipped };
}

/** 取 AzureCloud.<region>。实测它是该区域其他 service tag 的严格超集。 */
export function azureIntervals(serviceTags, regions) {
	const byName = new Map(serviceTags.values.map((v) => [v.name, v]));
	const out = [];
	const seen = [];
	for (const region of regions) {
		const name = `AzureCloud.${region}`;
		const v = byName.get(name);
		if (!v) throw new Error(`service tag 里没有 ${name}(区域名拼错?)`);
		const v4 = v.properties.addressPrefixes.filter((p) => p.indexOf(":") < 0);
		if (v4.length === 0) throw new Error(`${name} 没有 IPv4 前缀`);
		for (const p of v4) out.push(netToInterval(p));
		seen.push({ name, prefixes: v4.length });
	}
	return { intervals: merge(out), tags: seen };
}

/**
 * 分块拼接,而不是攒一个 5 万元素的 parts 数组再 join —— 那个数组本身要几 MB,
 * 而 128 MB 是 per-isolate 而非 per-invocation 的限额,余量得留足。
 */
const RSC_CHUNK_LINES = 4096;

export function renderRsc(listName, cidrs) {
	const chunks = [
		`/log info "Import ${listName} ipv4 cidr list..."\n` +
			`/ip firewall address-list remove [/ip firewall address-list find list=${listName}]\n` +
			`/ip firewall address-list\n`,
	];
	let buf = "";
	for (let i = 0; i < cidrs.length; i++) {
		buf += `:do {add address=${cidrs[i]} list=${listName}} on-error={}\n`;
		if ((i + 1) % RSC_CHUNK_LINES === 0) {
			chunks.push(buf);
			buf = "";
		}
	}
	if (buf.length > 0) chunks.push(buf);
	return chunks.join("");
}

export function renderTxt(cidrs) {
	return cidrs.length === 0 ? "" : cidrs.join("\n") + "\n";
}

/**
 * 完整流程。
 *
 * 每渲染好一份就交给 `emit(name, {txt, rsc, count})` 并立刻丢掉引用,不把四份
 * 输出同时攒在内存里 —— 实测同时持有是 9 MB 文本加上渲染时的临时数组,
 * 一份一份走能把峰值堆用量从 ~52 MiB 压到 ~20 MiB。
 *
 * 任何一步不满足前置/后置条件就抛错 —— 宁可不产出,也不要产出一份会把
 * 路由器 address-list 清成半成品、或者把隧道端点包进去的列表。
 */
export async function build({
	liteStream,
	serviceTags,
	countries,
	combinedName,
	azureRegions = [],
	excludeCidrs = [],
	emit,
	log = () => {},
}) {
	if (typeof emit !== "function") throw new Error("build 需要 emit 回调");
	const wanted = countries.map((c) => c.toUpperCase());
	if (wanted.length === 0) throw new Error("countries 为空");

	log(`目标地区: ${wanted.join(" ")}`);
	const { perCc, rows, skipped } = await readLite(liteStream, wanted, {
		onProgress: (n) => log(`  ... 已扫 ${n.toLocaleString("en-US")} 行`),
	});
	log(`  扫完 ${rows.toLocaleString("en-US")} 行,跳过 ${skipped} 行无法解析`);

	const merged = new Map();
	for (const cc of wanted) {
		const raw = perCc.get(cc);
		if (raw.length === 0) throw new Error(`${cc} 零命中,放弃(ISO 代码写错,或数据源格式变了)`);
		merged.set(cc, merge(raw));
		perCc.set(cc, null); // 原始区间已经没用了,放掉让 V8 回收
	}

	// 不变量:同一个地址只能属于一个地区。源数据若有重叠,后面的剔除和合并都不可信。
	for (let i = 0; i < wanted.length; i++) {
		for (let j = i + 1; j < wanted.length; j++) {
			const hit = intersects(merged.get(wanted[i]), merged.get(wanted[j]));
			if (hit) {
				throw new Error(
					`${wanted[i]} 与 ${wanted[j]} 区间重叠 ${JSON.stringify(hit)},源数据不满足互斥假设`,
				);
			}
		}
	}

	let cut = [];
	if (azureRegions.length > 0) {
		if (!serviceTags) throw new Error("指定了 azureRegions 但没给 serviceTags");
		log(`剔除 Azure 区域: ${azureRegions.join(" ")}`);
		const az = azureIntervals(serviceTags, azureRegions);
		for (const t of az.tags) log(`  ${t.name}: ${t.prefixes} 个 IPv4 前缀`);
		cut = cut.concat(az.intervals);
	}
	if (excludeCidrs.length > 0) {
		// 只打条数不打原文:这里通常放隧道端点,而日志可能是公开的。
		log(`剔除手工网段: ${excludeCidrs.length} 条`);
		excludeCidrs.forEach((c, idx) => {
			try {
				cut.push(netToInterval(c));
			} catch {
				throw new Error(`excludeCidrs 第 ${idx + 1} 项不是合法 IPv4 网段`);
			}
		});
	}
	cut = merge(cut);
	if (cut.length > 0) {
		log(`剔除集合: ${cut.length} 个区间 / ${countAddrs(cut).toLocaleString("en-US")} 个地址`);
	}

	const final = new Map();
	for (const cc of wanted) {
		const before = merged.get(cc);
		const after = subtract(before, cut);
		if (after.length === 0) throw new Error(`${cc} 剔除后为空,放弃`);
		const beforeAddrs = countAddrs(before);
		const afterAddrs = countAddrs(after);
		merged.set(cc, null); // 剔除前的区间用完了,别和剔除后的同时驻留
		final.set(cc, after);
		log(
			`  ${cc}: ${beforeAddrs.toLocaleString("en-US")} -> ` +
				`${afterAddrs.toLocaleString("en-US")} 个地址` +
				`(剔掉 ${(beforeAddrs - afterAddrs).toLocaleString("en-US")})`,
		);
	}

	// 各地区已两两互斥且各自有序,直接推进一个数组再 merge 就行;
	// merge 就地排序,所以这里只有一份拷贝的开销,不是 concat 链式那样的 N 份。
	const combinedRaw = [];
	for (const cc of wanted) for (const iv of final.get(cc)) combinedRaw.push(iv);
	const combinedIv = merge(combinedRaw);

	// 后置断言:剔除集合绝不能和任何一份输出相交。
	for (const cc of wanted) {
		const hit = intersects(final.get(cc), cut);
		if (hit) throw new Error(`${cc} 列表仍与剔除集合相交: ${JSON.stringify(hit)}`);
	}
	const hitC = intersects(combinedIv, cut);
	if (hitC) throw new Error(`合并列表仍与剔除集合相交: ${JSON.stringify(hitC)}`);

	const counts = new Map();
	const order = wanted.map((cc) => [`${cc}_CIDR_V4`, final.get(cc)]);
	order.push([combinedName, combinedIv]);

	for (const [name, intervals] of order) {
		const cidrs = toCidrs(intervals);
		// 渲染 -> 交出 -> 不保留引用,四份不同时驻留
		await emit(name, {
			txt: renderTxt(cidrs),
			rsc: renderRsc(name, cidrs),
			count: cidrs.length,
		});
		counts.set(name, cidrs.length);
		log(`  -> ${name}.rsc / .txt  (${cidrs.length} 条)`);
	}

	return { counts, stats: { rows, skipped, cutAddrs: countAddrs(cut) } };
}
