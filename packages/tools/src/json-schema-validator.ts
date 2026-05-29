import type { JsonSchemaLike } from "@jue/shared-types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * 项目工具协议目前使用 JSON Schema 描述输入输出。为了不把工具层绑死在某个
 * 第三方 validator 上，这里实现一份覆盖常用 schema 子集的轻量校验器。
 */
export class JsonSchemaValidator {
  validate(value: unknown, schema: JsonSchemaLike, rootPath = "$."): ValidationResult {
    const issues: ValidationIssue[] = [];
    validateAgainstSchema(value, schema, normalizePath(rootPath), issues);
    return { ok: issues.length === 0, issues };
  }
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
  issues: ValidationIssue[],
): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: "schema=false，不接受任何值" });
    return;
  }
  if (schema.enum && !schema.enum.some((item) => deepEqualJson(item, value))) {
    issues.push({ path, message: `必须是枚举值之一: ${schema.enum.map(String).join(", ")}` });
    return;
  }
  if (schema.const !== undefined && !deepEqualJson(schema.const, value)) {
    issues.push({ path, message: `必须等于 const=${String(schema.const)}` });
    return;
  }

  const type = schema.type;
  if (type !== undefined && !matchesJsonType(value, type)) {
    issues.push({ path, message: `类型不匹配，期望 ${Array.isArray(type) ? type.join("|") : type}` });
    return;
  }

  const effectiveType = Array.isArray(type) ? type[0] : type;
  if (effectiveType === "object" || (schema.properties && isPlainObject(value))) {
    validateObject(value, schema, path, issues);
  }
  if (effectiveType === "array" || (schema.items && Array.isArray(value))) {
    validateArray(value, schema, path, issues);
  }
  validateNumericBounds(value, schema, path, issues);
  validateStringBounds(value, schema, path, issues);
}

function validateObject(
  value: unknown,
  schema: Exclude<JsonSchemaLike, boolean>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "必须是对象" });
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) issues.push({ path: joinPath(path, key), message: "缺少必填字段" });
  }
  const properties = schema.properties ?? {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in obj) validateAgainstSchema(obj[key], childSchema, joinPath(path, key), issues);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) issues.push({ path: joinPath(path, key), message: "不允许的额外字段" });
    }
  } else if (schema.additionalProperties && schema.additionalProperties !== true) {
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) {
        validateAgainstSchema(obj[key], schema.additionalProperties, joinPath(path, key), issues);
      }
    }
  }
}

function validateArray(
  value: unknown,
  schema: Exclude<JsonSchemaLike, boolean>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "必须是数组" });
    return;
  }
  const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
  if (!itemSchema) return;
  value.forEach((item, index) => validateAgainstSchema(item, itemSchema, `${path}[${index}]`, issues));
}

function validateNumericBounds(
  value: unknown,
  schema: Exclude<JsonSchemaLike, boolean>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "number") return;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, message: `必须 >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({ path, message: `必须 <= ${schema.maximum}` });
  }
}

function validateStringBounds(
  value: unknown,
  schema: Exclude<JsonSchemaLike, boolean>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string") return;
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({ path, message: `长度必须 >= ${schema.minLength}` });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    issues.push({ path, message: `长度必须 <= ${schema.maxLength}` });
  }
}

function matchesJsonType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    if (item === "array") return Array.isArray(value);
    if (item === "object") return isPlainObject(value);
    if (item === "integer") return typeof value === "number" && Number.isInteger(value);
    if (item === "null") return value === null;
    return typeof value === item;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizePath(path: string): string {
  return path.endsWith(".") ? path.slice(0, -1) : path;
}

function joinPath(base: string, key: string): string {
  return base === "$" ? `$.${key}` : `${base}.${key}`;
}
