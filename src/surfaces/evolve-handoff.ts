/**
 * The handoff view: a projection of the memories table onto the four questions
 * a fresh session actually needs answered.
 *
 *   ① 我是谁 (who)      — what this workspace is, and by what rules work gets done
 *   ② 干到哪 (progress) — what actually landed, with evidence
 *   ③ 下一步 (next)     — who moves first, in what order
 *   ④ 卡在哪 (blocked)  — waiting on whom, or missing what
 *
 * Why a projection instead of a new table: the store already classifies rows by
 * `type` (`user` answers ①, `feedback` answers how work gets done, `reference`
 * answers where things are). ③ and ④ are L2 session state, which by design
 * never enters the store — so this view renders them as an explicit empty slot
 * rather than fabricating a memory that would rot.
 *
 * The empty slot must be stated. A model reading silence treats it as "nothing
 * to report", which is the failure this view exists to prevent.
 */

/** The four questions, in fixed order. Changing the paradigm means changing this table. */
const QUESTIONS = [
	{
		key: "who",
		title: "① 我是谁",
		hint: "这个工作区是什么、按什么规矩干活（来自 user / feedback 记忆）",
	},
	{
		key: "progress",
		title: "② 干到哪",
		hint: "已落地的实事 + 证据（来自 feedback 里带结果的行）",
	},
	{
		key: "next",
		title: "③ 下一步",
		hint: "谁先动、按什么顺序（L2 会话状态，默认不在库内）",
	},
	{
		key: "blocked",
		title: "④ 卡在哪",
		hint: "等谁 / 缺什么；没有就写「无」（同上，默认不在库内）",
	},
] as const;

type QuestionKey = (typeof QUESTIONS)[number]["key"];

/** Which question each stored `type` answers. Anything unlisted lands on ①. */
const TYPE_TO_QUESTION: Readonly<Record<string, QuestionKey>> = {
	user: "who",
	feedback: "progress",
	reference: "progress",
};

/** Options the view accepts; every one has a working default. */
export interface HandoffOptions {
	/** Per-entry summary cap, in characters. */
	maxChars?: number | undefined;
	/** Budget for the entry lines themselves (the skeleton is separate). */
	budget?: number | undefined;
	/** How many entries one question may list. */
	limit?: number | undefined;
}

const DEFAULT_MAX_CHARS = 90;
const DEFAULT_BUDGET = 2048;
const DEFAULT_LIMIT = 6;

/** A shape this view needs from a record; kept structural so tests can stub it. */
interface HandoffRecord {
	id: string;
	type: string;
	body: string;
	notWhen?: string | undefined;
}

/**
 * The label forms a feedback body's contract lines may take.
 *
 * `feedback` rows are gated on carrying `**Why:**` and `**How to apply:**`.
 * An earlier version filtered those lines out as noise, which emptied the whole
 * summary — the memory then vanished from the view entirely even though it had
 * been written successfully. Strip the label, keep the text.
 */
const CONTRACT_LABEL = /^\*\*(?:Why|How to apply)[:：]\*\*\s*|^(?:Why|How to apply)[:：]\s*/i;
const HOW_TO_APPLY = /^\*\*How to apply[:：]\*\*|^How to apply[:：]/i;
const WHY = /^\*\*Why[:：]\*\*|^Why[:：]/i;

/**
 * Collapse one memory body to a single line.
 *
 * The view is not a reader — bodies stay behind `evolve_read(id=…)`. This keeps
 * the actionable half of a feedback entry (its `How to apply` line) and falls
 * back to the first plain line.
 * @param body - The stored body.
 * @param maxChars - Character cap for the summary.
 * @returns One line, possibly clipped; empty when the body carries no text.
 */
function summarize(body: string, maxChars: number): string {
	const lines = body
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	const howLine = lines.find(line => HOW_TO_APPLY.test(line));
	const whyLine = lines.find(line => WHY.test(line));
	const plainLine = lines.find(line => !WHY.test(line) && !HOW_TO_APPLY.test(line));
	const chosen = howLine ?? plainLine ?? whyLine ?? "";
	// Collapse whitespace before clipping: a CJK sentence carrying a newline
	// would otherwise render far longer than the cap promises.
	const flat = chosen.replace(CONTRACT_LABEL, "").replace(/\s+/g, " ").trim();
	if (flat.length === 0) return "";
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * Estimate the fixed skeleton's size: headings, question headers, the empty-slot
 * text, and the footer.
 *
 * Only used to decide whether a budget is achievable at all — the reported
 * numbers use measured values. This is a worst-case figure (the footer's widest
 * form), which is the right direction for a budget guard.
 * @param workspaceId - The partition name, which appears in the title.
 * @param budget - The entry budget, which appears in the footer.
 * @returns Skeleton bytes under UTF-8.
 */
function skeletonBytesOf(workspaceId: string, budget: number): number {
	const skeleton = [
		`# 交接视图 · ${workspaceId}`,
		"> 四问范式：我是谁 / 干到哪 / 下一步 / 卡在哪。读完这四个就该能开工；",
		"> 细节不在这里，用 `evolve_read(kind, id)` 取原文。",
		...QUESTIONS.flatMap(question => [
			`## ${question.title}`,
			`<!-- ${question.hint} -->`,
			"（本库无此项：L2 会话状态按设计不进记忆库——请在会话里直接回答，或让用户告诉你）",
			"",
		]),
		"---",
		`共 999 条记忆 → ①99 ②99 ③99 ④99；条目 99999 字节（条目预算 ${budget}）`,
		"⚠ 因体积上限裁掉 999 条——这意味着交接可能不完整，优先看 ②「干到哪」是否有缺口。",
		"⚠ 条目预算 999 小于固定结构本身（约 9999 字节：标题/四问头/空位提示/尾注），实际输出必然超出。要更短请减少条目或改用 query 检索。",
	].join("\n");
	return Buffer.byteLength(skeleton, "utf8");
}

/**
 * Cut one line to a byte ceiling without splitting a multi-byte character.
 * @param line - The line to shorten.
 * @param keepBytes - Byte budget for the result, ellipsis included.
 * @returns The shortened line.
 */
function clipLine(line: string, keepBytes: number): string {
	const buf = Buffer.from(line, "utf8");
	if (buf.length <= keepBytes) return line;
	const tail = Buffer.from("…", "utf8");
	let end = Math.max(0, keepBytes - tail.length);
	// Walk back off a UTF-8 continuation byte so the cut never splits a character.
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return buf.subarray(0, end).toString("utf8") + "…";
}

/**
 * Trim entry lines to the budget known at call time.
 *
 * Two passes, in least-valuable-first order (progress → who → next → blocked):
 * drop whole lines while a question still has more than one, then shorten what
 * remains. Dropping first preserves one line per question; shortening second
 * preserves partial information instead of emptying a slot.
 * @param sections - Entry lines per question, mutated in place.
 * @param budget - Byte budget for the entry lines.
 * @param fixedCost - Skeleton bytes already committed.
 * @returns The dropped counts and the measured entry-line total.
 */
function clipToBudget(
	sections: Record<QuestionKey, string[]>,
	budget: number,
	fixedCost: number,
): { dropped: Partial<Record<QuestionKey, number>>; total: number } {
	const order: QuestionKey[] = ["progress", "who", "next", "blocked"];
	const dropped: Partial<Record<QuestionKey, number>> = {};
	const measure = (lines: string[]): number =>
		lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);

	let payload = 0;
	for (const key of order) payload += measure(sections[key]);
	let excess = fixedCost + payload - budget;

	// Pass one: drop whole lines, keeping at least one per question.
	for (const key of order) {
		if (excess <= 0) break;
		const lines = sections[key];
		while (excess > 0 && lines.length > 1) {
			const removed = lines.pop();
			if (removed === undefined) break;
			excess -= Buffer.byteLength(removed, "utf8") + 1;
			dropped[key] = (dropped[key] ?? 0) + 1;
		}
	}
	// Pass two: shorten the survivors rather than emptying them.
	if (excess > 0) {
		for (const key of order) {
			if (excess <= 0) break;
			const lines = sections[key];
			if (lines.length === 0) continue;
			const share = Math.ceil(excess / lines.length) + 8;
			for (let index = 0; index < lines.length && excess > 0; index += 1) {
				const before = Buffer.byteLength(lines[index] ?? "", "utf8");
				if (before <= 24) continue;
				const after = clipLine(lines[index] ?? "", Math.max(24, before - share));
				lines[index] = after;
				const saved = before - Buffer.byteLength(after, "utf8");
				if (saved > 0) {
					excess -= saved;
					dropped[key] = (dropped[key] ?? 0) + 1;
				}
			}
		}
	}

	let total = fixedCost;
	for (const key of order) total += measure(sections[key]);
	return { dropped, total };
}

/**
 * Render the handoff view for one workspace partition.
 * @param records - Every active record in the partition (the caller lists them).
 * @param workspaceId - The partition name, shown in the title.
 * @param options - Optional caps; see {@link HandoffOptions}.
 * @returns The four-question view as text.
 */
export function formatHandoff(records: HandoffRecord[], workspaceId: string, options: HandoffOptions = {}): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const budget = options.budget ?? DEFAULT_BUDGET;
	const limitPerQuestion = options.limit ?? DEFAULT_LIMIT;

	const sections: Record<QuestionKey, string[]> = { who: [], progress: [], next: [], blocked: [] };
	const counts: Record<QuestionKey, number> = { who: 0, progress: 0, next: 0, blocked: 0 };

	for (const record of records) {
		const question = TYPE_TO_QUESTION[record.type] ?? "who";
		counts[question] += 1;
		if (sections[question].length >= limitPerQuestion) continue;
		const summary = summarize(record.body, maxChars);
		if (summary.length === 0) continue;
		const notWhen =
			typeof record.notWhen === "string" && record.notWhen.length > 0 ? `（不适用：${record.notWhen}）` : "";
		sections[question].push(`- \`${record.id}\` ${summary}${notWhen}`);
	}

	const clipped = clipToBudget(sections, budget, skeletonBytesOf(workspaceId, budget));
	const out: string[] = [];
	out.push(`# 交接视图 · ${workspaceId}`);
	out.push("");
	out.push("> 四问范式：我是谁 / 干到哪 / 下一步 / 卡在哪。读完这四个就该能开工；");
	out.push("> 细节不在这里，用 `evolve_read(kind, id)` 取原文。");
	out.push("");

	for (const question of QUESTIONS) {
		const lines = sections[question.key];
		out.push(`## ${question.title}`);
		out.push(`<!-- ${question.hint} -->`);
		if (lines.length === 0) {
			out.push(
				question.key === "next" || question.key === "blocked"
					? "（本库无此项：L2 会话状态按设计不进记忆库——请在会话里直接回答，或让用户告诉你）"
					: "（本库无此项）",
			);
		} else {
			out.push(...lines);
			const trimmed = clipped.dropped[question.key] ?? 0;
			if (trimmed > 0) {
				out.push(`（另 ${trimmed} 条因体积上限未展开，用 \`evolve_read(…, query)\` 检索）`);
			}
			const remaining = counts[question.key] - lines.length - trimmed;
			if (remaining > 0) {
				out.push(`（另有 ${remaining} 条未列出，受每条上限 ${limitPerQuestion} 限制）`);
			}
		}
		out.push("");
	}

	out.push("---");
	// Report entry bytes only. The skeleton is fixed structure with no decision
	// value, and the footer itself belongs to it — folding it in makes the
	// number self-referential and never quite add up.
	let bodyBytes = 0;
	for (const key of Object.keys(sections) as QuestionKey[]) {
		bodyBytes += sections[key].reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
	}
	out.push(
		`共 ${records.length} 条记忆 → ①${counts.who} ②${counts.progress} ③${counts.next} ④${counts.blocked}` +
			`；条目 ${bodyBytes} 字节（条目预算 ${budget}）`,
	);
	const totalDropped = Object.values(clipped.dropped).reduce((sum, value) => sum + (value ?? 0), 0);
	if (totalDropped > 0) {
		out.push(`⚠ 因体积上限裁掉 ${totalDropped} 条——这意味着交接可能不完整，优先看 ②「干到哪」是否有缺口。`);
	}
	const skeleton = skeletonBytesOf(workspaceId, budget);
	if (budget < skeleton) {
		out.push(
			`⚠ 条目预算 ${budget} 小于固定结构本身（约 ${skeleton} 字节：标题/四问头/空位提示/尾注），` +
				"实际输出必然超出。要更短请减少条目或改用 query 检索。",
		);
	}
	return out.join("\n");
}
