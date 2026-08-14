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
const models = new Map();       // model name → { fields:Set, relations:Map<field, model> }
const modelNames = new Set();

for (const match of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(match[1]);

for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = match;
    const fields = new Set();
    const relations = new Map();

    for (const line of body.split('\n')) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

        const field = line.match(/^\s{2}(\w+)\s+(\w+)/);
        if (!field) continue;

        const [, name, type] = field;
        fields.add(name);
        // A field typed as another model is a relation we can follow.
        if (modelNames.has(type)) relations.set(name, type);
    }

    models.set(model, { fields, relations });
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

/** Top-level `key:` entries of an object literal, with each value's block. */
const entries = (block) => {
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
        if (!key || !/[{,\s]/.test(block[i - 1] || '')) continue;

        const after = i + key[0].length;
        const brace = block.slice(after).match(/^\s*\{/);
        const ident = brace ? null : block.slice(after).match(/^\s*(\w+)\s*[,}]/);
        found.push({
            key: key[1],
            block: brace ? readBlock(block, after + brace[0].length - 1) : '',
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

        const args = readBlock(src, src.indexOf('{', call.index + call[0].length - 1));
        if (!args) continue;

        const line = src.slice(0, call.index).split('\n').length;
        for (const { key, block, ident } of entries(args)) {
            if (key !== 'select' && key !== 'include') continue;

            const resolved = block || constantBlock(src, ident);
            if (resolved) checkBlock(resolved, def.name, file, line, 0, src);
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
