#!/usr/bin/env node
/**
 * Catch Prisma `select` / `include` keys that name a field the model does not
 * have — including through relations.
 *
 * Prisma validates a query when it runs, not when the module loads. A field
 * that only ever existed in Mongo therefore sails through `node --check`,
 * through importing the app, and through any code path no test executes, then
 * throws the first time that endpoint is hit in production. Three such bugs
 * reached main during this migration before this script existed.
 *
 *   node scripts/check-prisma-fields.mjs
 *
 * Exits non-zero if anything looks wrong.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schema = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');

/** Prisma's delegate name is the model name with a lowercased first letter. */
const delegateOf = (model) => model.charAt(0).toLowerCase() + model.slice(1);

// ── schema: model → { fields, relations } ────────────────────────────────────
const models = new Map();       // model name → { fields:Set, relations:Map<field, model>, enums:Map<field, enum> }
const modelNames = new Set();

/**
 * enum name → the members code must use.
 *
 * The Prisma name is what a query passes, not the database value: a member
 * written `in_progress @map("in-progress")` is `in_progress` in code. Filtering
 * on a value that is not a member throws at execution — Mongo simply matched
 * nothing, so several such filters survived the migration and read as an empty
 * result rather than an error.
 */
/** Schema files may arrive with either line ending. */
const SPLIT_LINES = /\r?\n/;
const enums = new Map();
for (const match of schema.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const members = new Set();
    for (const line of body.split(SPLIT_LINES)) {
        const member = line.trim().match(/^(\w+)/);
        if (member && !line.trim().startsWith('//')) members.add(member[1]);
    }
    enums.set(name, members);
}

for (const match of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(match[1]);

for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = match;
    const fields = new Set();
    const relations = new Map();
    const enumFields = new Map();

    // `@@unique([a, b])` and `@@id([a, b])` are addressable in a `where` under
    // the joined name Prisma generates for them, e.g. `entityType_entityId`.
    for (const compound of body.matchAll(/@@(?:unique|id)\(\s*(?:name:\s*"(\w+)",\s*)?\[([^\]]+)\]/g)) {
        fields.add(compound[1] || compound[2].split(',').map((f) => f.trim()).join('_'));
    }

    for (const line of body.split('\n')) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

        const field = line.match(/^\s{2}(\w+)\s+(\w+)/);
        if (!field) continue;

        const [, name, type] = field;
        fields.add(name);
        // A field typed as another model is a relation we can follow.
        if (modelNames.has(type)) relations.set(name, type);
        if (enums.has(type)) enumFields.set(name, type);
    }

    models.set(model, { fields, relations, enums: enumFields });
}

const byDelegate = new Map([...models].map(([name, def]) => [delegateOf(name), { name, ...def }]));

// ── source scan ──────────────────────────────────────────────────────────────
const sourceFiles = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.js')) {
            sourceFiles.push(full);
        }
    }
};
walk(path.join(root, 'src'));

/** Read the balanced { … } starting at `open`. */
const readBlock = (text, open) => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(open, i + 1);
        }
    }
    return '';
};

/**
 * Blanks out whole-line comments, preserving length so every offset still lines
 * up with the original block.
 *
 * Without this the "a key follows `{` or `,`" rule below reads the last
 * character of a comment line as the predecessor, and silently skips the key
 * after it. That is a false negative rather than a false positive, so it hid
 * rather than shouted: `paymentStatus: { in: [...] }` sat directly under a
 * comment and went unchecked, including the invalid enum member in it.
 *
 * Only full-line comments are removed. A `//` inside a string — a URL, say — is
 * left alone.
 */
const blankLineComments = (block) => block
    .split(SPLIT_LINES)
    .map((line) => {
        const trimmed = line.trimStart();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        return isComment ? ' '.repeat(line.length) : line;
    })
    .join('\n');

/** Top-level `key:` entries of an object literal, with each value's block. */
const entries = (rawBlock) => {
    const block = blankLineComments(rawBlock);
    const found = [];
    let depth = 0;
    for (let i = 0; i < block.length; i += 1) {
        const ch = block[i];
        if (ch === '{' || ch === '[') {
            depth += 1;
            continue;
        }
        if (ch === '}' || ch === ']') {
            depth -= 1;
            continue;
        }
        if (depth !== 1) continue;

        const key = block.slice(i).match(/^(\w+)\s*:/);
        if (!key) continue;

        // A real key opens the object or follows a comma. Anything else that
        // looks like `word:` is prose in a comment, a `case` label, or the
        // second half of a ternary — all of which used to be reported.
        const before = block.slice(0, i).trimEnd().slice(-1);
        if (before !== '{' && before !== ',') continue;

        const after = i + key[0].length;
        const brace = block.slice(after).match(/^\s*\{/);
        const ident = brace ? null : block.slice(after).match(/^\s*(\w+)\s*[,}]/);
        found.push({
            key: key[1],
            block: brace ? readBlock(rawBlock, after + brace[0].length - 1) : '',
            ident: ident ? ident[1] : '',
        });
    }
    return found;
};

/**
 * `select: SOME_CONST` → the object literal that constant was declared with.
 *
 * Naming the column set is the common pattern in this codebase, so without this
 * the majority of selects would go unchecked.
 */
const constantBlock = (src, ident) => {
    if (!ident || !src) return '';

    const decl = src.match(new RegExp(String.raw`const\s+${ident}\s*=\s*\{`));
    if (!decl) return '';

    return readBlock(src, decl.index + decl[0].length - 1);
};

const problems = [];

const report = (file, line, modelName, key) =>
    problems.push(`${path.relative(root, file)}:${line}  ${modelName} has no field "${key}"`);

/**
 * Enum values a `where` filters on must be members of that enum.
 *
 * Prisma rejects the query outright; Mongo matched nothing. So a filter naming
 * a status that never existed used to read as "no results" and now reads as a
 * 500 — which is how `paymentStatus: { in: ["created", "pending", "failed"] }`
 * survived, `pending` not being an OrderPaymentStatus. Four filters of this
 * shape were found by hand during the migration before this check existed.
 *
 * Only literal strings are checked. A value built at runtime is skipped rather
 * than guessed at.
 */
const LITERAL = /^\s*(['"])([\w-]+)\1\s*[,}\]]/;
const VALUE_OPS = new Set(['equals', 'not', 'in', 'notIn']);

const checkEnumValue = (raw, enumName, file, line, modelName, field) => {
    const members = enums.get(enumName);
    if (!members) return;
    for (const match of raw.matchAll(/(['"])([\w-]+)\1/g)) {
        const value = match[2];
        if (!members.has(value)) {
            problems.push(
                `${path.relative(root, file)}:${line}  ${modelName}.${field} is ${enumName};`
                + ` "${value}" is not one of ${[...members].join(', ')}`,
            );
        }
    }
};

/** Keys of a `where` that combine conditions rather than name a column. */
const LOGICAL = new Set(['AND', 'OR', 'NOT']);
/** Keys that wrap a condition on the far side of a relation. */
const RELATION_OPS = new Set(['some', 'every', 'none', 'is', 'isNot']);

/**
 * Check one `where` block against `model`.
 *
 * Only the top level of each object is checked — what sits under a scalar field
 * is an operator (`gte`, `contains`, `mode`…), not a column. Conditions inside
 * an `AND: [...]` array are skipped rather than guessed at: this script must
 * never report something that is actually fine.
 */
const checkWhere = (block, modelName, file, line, seen = 0) => {
    const def = models.get(modelName);
    if (!def || seen > 4) return;

    for (const { key, block: nested } of entries(block)) {
        if (LOGICAL.has(key)) {
            if (nested) checkWhere(nested, modelName, file, line, seen + 1);
            continue;
        }
        if (!def.fields.has(key)) {
            report(file, line, modelName, key);
            continue;
        }

        // An enum column: the value has to be a member of that enum.
        const enumName = def.enums.get(key);
        if (enumName) {
            const after = block.slice(block.indexOf(key + ':') + key.length + 1);
            if (nested) {
                // `{ status: { in: [...] } }` — check only the value operators;
                // `mode`, `gte` and friends carry no enum member.
                for (const op of entries(nested)) {
                    if (VALUE_OPS.has(op.key)) {
                        const seg = nested.slice(nested.indexOf(op.key + ':') + op.key.length + 1);
                        checkEnumValue(seg.split(/[,}]/)[0] + (op.block || ''), enumName, file, line, modelName, key);
                    }
                }
                const arrays = nested.match(/\b(?:in|notIn)\s*:\s*\[[^\]]*\]/g) || [];
                for (const arr of arrays) checkEnumValue(arr, enumName, file, line, modelName, key);
            } else {
                const literal = after.match(LITERAL);
                if (literal) checkEnumValue(literal[0], enumName, file, line, modelName, key);
            }
            continue;
        }

        const related = def.relations.get(key);
        if (!related || !nested) continue;

        // `{ restaurant: { name: … } }` and `{ items: { some: { name: … } } }`
        // both describe the related model; the second is one level deeper.
        // `{ is: null }` and `{ none: {} }` are operators on the relation, not
        // columns of it. Recursing into them as a field list reports the
        // operator itself as an unknown field.
        const wrapped = entries(nested).filter((e) => RELATION_OPS.has(e.key));
        if (wrapped.length) {
            for (const w of wrapped) {
                if (w.block) checkWhere(w.block, related, file, line, seen + 1);
            }
        } else {
            checkWhere(nested, related, file, line, seen + 1);
        }
    }
};

/**
 * Check one `data` / `create` / `update` block against `model`.
 *
 * Every key at this level is a column or a relation; the nested-write verbs
 * (`create`, `connect`, `set`, `increment`…) only appear one level down, so a
 * top-level key that is not a field is always wrong.
 */
const checkData = (block, modelName, file, line) => {
    const def = models.get(modelName);
    if (!def) return;
    for (const { key } of entries(block)) {
        if (!def.fields.has(key)) report(file, line, modelName, key);
    }
};

/** Keys Prisma allows in an orderBy that are not columns. */
const ORDER_META = new Set(['_count', '_relevance', '_avg', '_sum', '_min', '_max']);

/**
 * Ordering by a column that does not exist.
 *
 * Keys only — the values are 'asc'/'desc', and a relation ordering such as
 * `{ restaurant: { name: 'asc' } }` stops at the relation rather than
 * recursing. Shallow, but it catches the case this was written for:
 * FoodTransactionHistory stamps its rows `at`, not `createdAt`, and ordering
 * on the wrong one throws at execution like every other Prisma mistake here.
 */
const checkOrderBy = (block, modelName, file, line) => {
    const def = models.get(modelName);
    if (!def) return;
    for (const { key } of entries(block)) {
        if (!ORDER_META.has(key) && !def.fields.has(key)) report(file, line, modelName, key);
    }
};

/** Check one select/include block against `model`, following relations. */
const checkBlock = (block, modelName, file, line, seen = 0, src = '') => {
    const def = models.get(modelName);
    // 4 levels is far deeper than anything here; the guard is for safety.
    if (!def || seen > 4) return;

    for (const { key, block: nested, ident } of entries(block)) {
        if (!def.fields.has(key)) {
            problems.push(
                `${path.relative(root, file)}:${line}  ${modelName} has no field "${key}"`,
            );
            continue;
        }

        const related = def.relations.get(key);
        if (!related || !nested) continue;

        // `{ restaurant: { select: {...} } }` describes the related model.
        for (const clause of entries(nested)) {
            if (clause.key !== 'select' && clause.key !== 'include') continue;
            const resolved = clause.block || constantBlock(src, clause.ident);
            if (resolved) checkBlock(resolved, related, file, line, seen + 1, src);
        }
    }
};

for (const file of sourceFiles) {
    const src = fs.readFileSync(file, 'utf8');

    for (const call of src.matchAll(/prisma\.(\w+)\.(\w+)\s*\(/g)) {
        const def = byDelegate.get(call[1]);
        if (!def) continue;

        // The argument has to start right here. Scanning forward for the next
        // `{` instead means a call written as `deleteMany(byPartner)` — or with
        // no argument at all — picks up an unrelated object further down the
        // file and checks it against the wrong model.
        const rest = src.slice(call.index + call[0].length);
        const literal = rest.match(/^\s*\{/);
        const named = literal ? null : rest.match(/^\s*(\w+)\s*\)/);

        const args = literal
            ? readBlock(src, call.index + call[0].length + literal[0].length - 1)
            : constantBlock(src, named?.[1]);
        if (!args) continue;

        const line = src.slice(0, call.index).split('\n').length;
        for (const { key, block, ident } of entries(args)) {
            const resolved = block || constantBlock(src, ident);
            if (!resolved) continue;

            if (key === 'select' || key === 'include') {
                checkBlock(resolved, def.name, file, line, 0, src);
            } else if (key === 'where') {
                checkWhere(resolved, def.name, file, line);
            } else if (key === 'data' || key === 'create' || key === 'update') {
                checkData(resolved, def.name, file, line);
            } else if (key === 'orderBy') {
                checkOrderBy(resolved, def.name, file, line);
            }
        }
    }
}

if (problems.length) {
    const unique = [...new Set(problems)];
    console.error(`${unique.length} suspect field reference(s):\n`);
    for (const p of unique) console.error('  ' + p);
    process.exit(1);
}

console.log(`checked ${sourceFiles.length} files against ${models.size} models — no unknown fields`);
