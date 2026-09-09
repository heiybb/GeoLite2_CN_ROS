/**
 * 拿 worker 的 JS 逻辑和 generate.py 已验证过的产出做逐字节对比。
 *
 * 用法(在仓库根目录):
 *   node worker/test/compare.mjs <ipinfo_lite.csv.gz> <ServiceTags_Public_*.json> [EXCLUDE_CIDR]
 *
 * 参照文件取仓库根目录下 generate.py 生成的那几份,所以 EXCLUDE_CIDR 必须和
 * 生成它们时用的一致,否则对比无意义。
 */
import { createReadStream, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { build } from "../src/lib.js";

const [litePath, tagsPath, excludeArg = ""] = process.argv.slice(2);
if (!litePath || !tagsPath) {
	console.error("用法: node worker/test/compare.mjs <lite.csv.gz> <servicetags.json> [EXCLUDE_CIDR]");
	process.exit(2);
}

const COUNTRIES = ["CN", "HK", "SG"];
const COMBINED = "CN_HK_SG_CIDR_V4";
const AZURE_REGIONS = ["southeastasia"];
const EXCLUDE = excludeArg.split(/\s+/).filter(Boolean);

if (typeof DecompressionStream === "undefined") {
	console.error("这个 node 没有全局 DecompressionStream —— Worker 里靠它解压,换个新版 node");
	process.exit(2);
}
console.log(`node ${process.version},DecompressionStream 可用`);

// 走和 Worker 完全相同的解压路径:字节流 -> DecompressionStream('gzip')
const fileStream = Readable.toWeb(createReadStream(litePath));
const liteStream = litePath.endsWith(".gz")
	? fileStream.pipeThrough(new DecompressionStream("gzip"))
	: fileStream;

const serviceTags = JSON.parse(readFileSync(tagsPath, "utf-8"));

// Worker 里 emit 是「上传到 R2 就丢」;这里为了对比才留下来,并顺手记录
// 交出每一份时的堆用量,那才是映射到 isolate 128 MB 限额的数字。
const files = new Map();
let peakHeap = 0;
const t0 = Date.now();
const { stats } = await build({
	liteStream,
	serviceTags,
	countries: COUNTRIES,
	combinedName: COMBINED,
	azureRegions: AZURE_REGIONS,
	excludeCidrs: EXCLUDE,
	emit: (name, f) => {
		peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		files.set(name, f);
	},
	log: (m) => console.log(m),
});
const ms = Date.now() - t0;
peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
console.log(
	`\nJS 用时 ${(ms / 1000).toFixed(2)}s,交出各份时的峰值 heapUsed ` +
		`${(peakHeap / 1048576).toFixed(1)} MiB(含本测试为对比而保留的全部文本)\n`,
);

let bad = 0;
for (const [name, f] of files) {
	for (const ext of ["txt", "rsc"]) {
		const ref = `${name}.${ext}`;
		let want;
		try {
			want = readFileSync(ref, "utf-8");
		} catch {
			console.log(`  ${ref.padEnd(26)} 参照文件不存在,跳过`);
			continue;
		}
		const got = ext === "txt" ? f.txt : f.rsc;
		if (got === want) {
			console.log(`  ${ref.padEnd(26)} 完全一致 (${statSync(ref).size} bytes)`);
		} else {
			bad++;
			console.log(`  ${ref.padEnd(26)} !!! 不一致`);
			const a = got.split("\n");
			const b = want.split("\n");
			console.log(`      行数 js=${a.length} py=${b.length}`);
			let shown = 0;
			for (let i = 0; i < Math.max(a.length, b.length) && shown < 5; i++) {
				if (a[i] !== b[i]) {
					console.log(`      行 ${i + 1}:\n        js: ${a[i]}\n        py: ${b[i]}`);
					shown++;
				}
			}
		}
	}
}
console.log(`\n扫了 ${stats.rows.toLocaleString("en-US")} 行,剔除 ${stats.cutAddrs.toLocaleString("en-US")} 个地址`);
console.log(bad === 0 ? "全部逐字节一致 ✓" : `${bad} 个文件不一致 ✗`);
process.exit(bad === 0 ? 0 : 1);
