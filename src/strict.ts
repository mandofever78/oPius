/**
 * Strict tool schemas for tools that request JSON-schema constrained sampling, matching pi-ai's
 * `constrained-sampling` module. pi supplies only package roots to extensions, and that module is
 * not exported from pi-ai's root, so it is mirrored here.
 */
import type { Tool } from "@earendil-works/pi-ai";

type Schema = Record<string, any>;

class Unsupported extends Error {}

const UNSUPPORTED_KEYS = ["$ref", "$defs", "definitions", "allOf", "oneOf", "patternProperties", "dependentSchemas", "dependencies", "unevaluatedProperties", "propertyNames", "contains", "prefixItems", "not", "if", "then", "else"];

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

function types(schema: Schema): unknown[] {
	return typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
}

function structured(schema: unknown): boolean {
	if (!isSchema(schema)) return false;
	const t = types(schema);
	return t.includes("object") || t.includes("array") || schema.properties !== undefined || schema.items !== undefined;
}

function allowsNull(schema: unknown): boolean {
	if (!isSchema(schema)) return false;
	if (types(schema).includes("null") || schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull);
}

/** Every property required (optional ones become nullable) and no additional properties. */
function strictNode(schema: unknown): void {
	if (!isSchema(schema)) throw new Unsupported("boolean schemas are unsupported");
	for (const key of UNSUPPORTED_KEYS) if (schema[key] !== undefined) throw new Unsupported(`${key} schemas are unsupported`);
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new Unsupported("anyOf must contain at least one schema");
		for (const variant of schema.anyOf) {
			if (structured(variant)) throw new Unsupported("object and array unions are unsupported");
			strictNode(variant);
		}
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) throw new Unsupported("tuple schemas are unsupported");
		strictNode(schema.items);
	}
	if (schema.type !== "object") {
		if (schema.properties !== undefined) throw new Unsupported("properties require type object");
		return;
	}
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Unsupported("schema-valued or true additionalProperties is unsupported");
	if (schema.properties !== undefined && !isSchema(schema.properties)) throw new Unsupported("object properties must be a schema map");
	if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string"))) {
		throw new Unsupported("object required must be a string array");
	}
	const properties: Schema = schema.properties ?? {};
	const names = Object.keys(properties);
	const required = new Set<string>(schema.required ?? []);
	if ([...required].some((key) => !names.includes(key))) throw new Unsupported("required contains an unknown property");
	for (const [key, property] of Object.entries(properties)) {
		strictNode(property);
		if (!required.has(key) && !allowsNull(property)) properties[key] = { anyOf: [property, { type: "null" }] };
	}
	schema.required = names;
	schema.additionalProperties = false;
}

/**
 * The strict schema for a tool that asks for constrained sampling, or undefined when it does not
 * or its schema cannot be made strict under "prefer". Throws when "require" cannot be honored.
 */
export function strictSchema(tool: Tool): Schema | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;
	try {
		const schema = structuredClone(tool.parameters) as unknown;
		if (!isSchema(schema) || schema.type !== "object") throw new Unsupported("root schema must have type object");
		strictNode(schema);
		return schema;
	} catch (error) {
		if (!(error instanceof Unsupported)) throw error;
		if (config.strict === "require") throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		return undefined;
	}
}
