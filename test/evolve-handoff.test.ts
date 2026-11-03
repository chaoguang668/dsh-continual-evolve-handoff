/**
 * The handoff view is a projection, so every assertion here is about what a
 * fresh session can learn from it: the four questions appear in order, empty
 * slots are stated rather than omitted, and clipping tells the truth.
 *
 * The failure this guards against is silent: a view that looks complete but
 * dropped a memory gives the reader no signal at all.
 */
import { describe, expect, it } from "vitest";
import { formatHandoff } from "../src/surfaces/evolve-handoff.js";

/** A record shape the view consumes; kept minimal on purpose. */
function record(id: string, type: string, body: string, notWhen?: string) {
	return { id, type, body, notWhen };
}

describe("handoff view: structure", () => {
	it("renders all four questions in fixed order", () => {
		const text = formatHandoff([], "WS");
		const positions = ["① 我是谁", "② 干到哪", "③ 下一步", "④ 卡在哪"].map(title => text.indexOf(title));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("states the ③/④ empty slot as L2 session state instead of omitting it", () => {
		const text = formatHandoff([], "WS");
		// Both ③ and ④ must carry the L2 explanation — that is the marker that
		// tells a reader "this is not knowledge, it is session state".
		const matches = text.match(/L2 会话状态按设计不进记忆库/g) ?? [];
		expect(matches.length).toBe(2);
	});

	it("marks ①/② empty without the L2 explanation", () => {
		const text = formatHandoff([], "WS");
		const who = text.slice(text.indexOf("## ①"), text.indexOf("## ②"));
		expect(who).toContain("（本库无此项）");
		expect(who).not.toContain("L2 会话状态");
	});

	it("reports the workspace name in the title", () => {
		expect(formatHandoff([], "F:\\some\\workspace")).toContain("F:\\some\\workspace");
	});
});

describe("handoff view: routing", () => {
	it("routes user memories to ① and feedback to ②", () => {
		const text = formatHandoff(
			[
				record("stack", "user", "TypeScript monorepo"),
				record("lint", "feedback", "**Why:** slow\n**How to apply:** use oxlint"),
			],
			"WS",
		);
		const who = text.slice(text.indexOf("## ①"), text.indexOf("## ②"));
		const progress = text.slice(text.indexOf("## ②"), text.indexOf("## ③"));
		expect(who).toContain("`stack`");
		expect(progress).toContain("`lint`");
	});

	it("keeps reference rows out of the four questions and counts them instead", () => {
		// A pointer is not a conclusion. Folding reference into ② once pushed the
		// real feedback rows past the per-question limit (48 pointers vs 14
		// conclusions in a real store), leaving the view non-actionable.
		const text = formatHandoff(
			[
				record("lint", "feedback", "**Why:** slow\n**How to apply:** use oxlint"),
				record("src", "reference", "source at C:\\work"),
			],
			"WS",
		);
		expect(text).not.toContain("`src`");
		expect(text).not.toContain("C:\\work");
		expect(text).toContain("另有 reference 1 条");
	});

	it("never lets reference rows displace feedback entries", () => {
		const rows = [
			record("real", "feedback", "**Why:** because\n**How to apply:** do the thing"),
			...Array.from({ length: 30 }, (_, index) => record(`ptr${index}`, "reference", `pointer ${index}`)),
		];
		const text = formatHandoff(rows, "WS", { limit: 2 });
		const progress = text.slice(text.indexOf("## ②"), text.indexOf("## ③"));
		expect(progress).toContain("`real`");
		expect(progress).not.toContain("`ptr0`");
	});

	it("counts an unknown type as unlisted rather than dropping it silently", () => {
		const text = formatHandoff([record("odd", "something-new", "kept anyway")], "WS");
		expect(text).toContain("something-new 1 条");
		expect(text).toContain("共 1 条记忆");
	});
});

describe("handoff view: feedback summaries", () => {
	it("keeps a feedback body visible by stripping the contract labels", () => {
		// Regression: filtering label lines outright emptied the summary, so a
		// successfully written memory vanished from the view entirely.
		const text = formatHandoff(
			[record("use-oxlint", "feedback", "**Why:** eslint is 3x slower.\n**How to apply:** run oxlint first.")],
			"WS",
		);
		expect(text).toContain("`use-oxlint`");
		expect(text).toContain("run oxlint first.");
	});

	it("prefers the How-to-apply line over the Why line", () => {
		const text = formatHandoff(
			[record("x", "feedback", "**Why:** the reason.\n**How to apply:** the action.")],
			"WS",
		);
		expect(text).toContain("the action.");
		expect(text).not.toContain("the reason.");
	});

	it("falls back to the Why line when no plain line exists", () => {
		const text = formatHandoff([record("y", "feedback", "**Why:** only a reason.")], "WS");
		expect(text).toContain("only a reason.");
	});

	it("includes the notWhen caveat when present", () => {
		const text = formatHandoff([record("z", "user", "body", "small projects only")], "WS");
		expect(text).toContain("（不适用：small projects only）");
	});
});

describe("handoff view: clipping honesty", () => {
	it("clips a long summary to maxChars", () => {
		const text = formatHandoff([record("long", "user", "word ".repeat(200))], "WS", { maxChars: 20 });
		// The rendered line carries the id prefix; assert the body was cut.
		expect(text).toContain("…");
		const line = text.split("\n").find(candidate => candidate.includes("`long`")) ?? "";
		expect(line.length).toBeLessThan(80);
	});

	it("says how many entries a per-question limit hid", () => {
		const many = Array.from({ length: 10 }, (_, index) => record(`u${index}`, "user", `body ${index}`));
		const text = formatHandoff(many, "WS", { limit: 2 });
		expect(text).toContain("受每条上限 2 限制");
	});

	it("warns that the view is incomplete when the budget drops entries", () => {
		const many = Array.from({ length: 40 }, (_, index) => record(`u${index}`, "user", "x".repeat(120)));
		const text = formatHandoff(many, "WS", { budget: 1500, limit: 20 });
		expect(text).toContain("因体积上限裁掉");
		expect(text).toContain("交接可能不完整");
	});

	it("warns when the budget cannot beat the fixed skeleton", () => {
		const text = formatHandoff([record("a", "user", "body")], "WS", { budget: 100 });
		expect(text).toContain("小于固定结构本身");
		expect(text).toContain("实际输出必然超出");
	});

	it("keeps at least one line per question when dropping", () => {
		const many = Array.from({ length: 20 }, (_, index) => record(`u${index}`, "user", "y".repeat(200)));
		const text = formatHandoff(many, "WS", { budget: 1600 });
		const who = text.slice(text.indexOf("## ①"), text.indexOf("## ②"));
		expect(who).toContain("- `");
	});
});

describe("handoff view: counters", () => {
	it("counts every record by destination question", () => {
		const text = formatHandoff(
			[
				record("a", "user", "one"),
				record("b", "user", "two"),
				record("c", "feedback", "**Why:** three\n**How to apply:** four"),
			],
			"WS",
		);
		expect(text).toContain("共 3 条记忆 → ①2 ②1 ③0 ④0");
	});

	it("reports entry bytes against the entry budget", () => {
		const text = formatHandoff([record("a", "user", "one")], "WS", { budget: 4096 });
		expect(text).toMatch(/条目 \d+ 字节（条目预算 4096）/);
	});
});
