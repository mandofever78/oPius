import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { strictSchema } from "../src/strict.ts";

const root = new URL("../", import.meta.url);

test("shipped code imports pi packages only by their root, the only entry pi supplies to extensions", () => {
	const files = ["index.ts", ...readdirSync(new URL("src/", root)).map((f) => `src/${f}`)];
	for (const file of files) {
		const deep = readFileSync(new URL(file, root), "utf8").match(/from\s+"@earendil-works\/[^/"]+\/[^"]*"/g);
		assert.equal(deep, null, `${file} imports a pi package subpath`);
	}
});

test("strict schemas match pi-ai's constrained sampling", () => {
	const schemas = [
		Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
		Type.Object({ path: Type.String(), tags: Type.Optional(Type.Array(Type.String())), mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])) }),
		Type.Object({ nested: Type.Object({ x: Type.Optional(Type.Integer()) }) }),
	];
	for (const parameters of schemas) {
		const tool = { name: "t", description: "", parameters, constrainedSampling: { type: "json_schema", strict: "prefer" } } as const;
		assert.deepEqual(strictSchema(tool as any), makeStrictJsonSchema(parameters));
	}
});

test("require fails loudly when a schema cannot be strict", () => {
	const parameters = Type.Object({ data: Type.Record(Type.String(), Type.String()) });
	assert.throws(() => strictSchema({ name: "t", description: "", parameters, constrainedSampling: { type: "json_schema", strict: "require" } } as any), /requires JSON-schema constrained sampling/);
});
