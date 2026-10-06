import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../../../../config/prisma.js';
import { config } from '../../../../config/env.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { buildPublicUrl, deleteStoredFile } from '../../../../services/storage.service.js';

/**
 * Gallery: the files in upload storage (local disk or S3, whichever the
 * server uses), searchable, with their public URL, and deletable only when
 * nothing in the database refers to them any more.
 *
 * "Refers to" is checked rather than assumed: an uploaded file's name is a
 * timestamp plus random hex, so it appears in a text, JSON or array column
 * exactly when something points at it. Every such column in the public schema
 * is searched for the name before a delete -- one scan per table.
 */

const MAX_FILES = 20000;
const useS3 = () => String(process.env.UPLOAD_DRIVER || '').toLowerCase() === 's3';

/** A stored path as the admin sends it back: relative, no "..", no leading slash. */
export function cleanStoredPath(value) {
    const clean = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^uploads\//, '');
    if (!clean || clean.includes('..') || clean.startsWith('.') || /[\0]/.test(clean)) {
        throw new ValidationError('Invalid file path');
    }
    return clean;
}

const kindOf = (name) => {
    const ext = path.extname(name).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(ext)) return 'image';
    if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
    if (ext === '.pdf') return 'pdf';
    return 'file';
};

const toEntry = (relativePath, size, modifiedAt) => {
    const name = path.posix.basename(relativePath);
    return {
        path: relativePath,
        name,
        folder: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
        kind: kindOf(name),
        size,
        modifiedAt,
        url: buildPublicUrl(relativePath),
    };
};

async function walkDisk(root, prefix = '') {
    const files = [];
    const queue = [prefix];
    while (queue.length && files.length < MAX_FILES) {
        const relativeDir = queue.shift();
        let entries = [];
        try {
            entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) queue.push(relative);
            else if (entry.isFile()) {
                const stat = await fs.stat(path.join(root, relative));
                files.push(toEntry(relative, stat.size, stat.mtime));
                if (files.length >= MAX_FILES) break;
            }
        }
    }
    return files;
}

async function walkS3(prefix = '') {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: process.env.UPLOAD_S3_REGION || process.env.AWS_REGION || 'ap-south-1' });
    const base = String(process.env.UPLOAD_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
    const fullPrefix = [base, prefix].filter(Boolean).join('/');
    const files = [];
    let token;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: process.env.UPLOAD_S3_BUCKET,
            Prefix: fullPrefix ? `${fullPrefix}/` : undefined,
            ContinuationToken: token,
        }));
        for (const object of page.Contents || []) {
            const relative = base ? object.Key.slice(base.length + 1) : object.Key;
            if (relative && !relative.endsWith('/')) files.push(toEntry(relative, object.Size || 0, object.LastModified || null));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && files.length < MAX_FILES);
    return files;
}

/** Files in upload storage, newest first, filtered by folder and name. */
export async function listGalleryFiles(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 48, 1), 200);
    const folder = query.folder ? cleanStoredPath(query.folder) : '';
    const search = String(query.search || '').trim().toLowerCase();
    const kind = ['image', 'video', 'pdf', 'file'].includes(query.kind) ? query.kind : '';

    const all = useS3() ? await walkS3(folder) : await walkDisk(path.resolve(config.uploadStorageRoot), folder);
    const files = all
        .filter((file) => (!search || file.path.toLowerCase().includes(search)) && (!kind || file.kind === kind))
        .sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));

    // Folders two levels deep ("food/reels"), for the filter.
    const folders = [...new Set(all.map((file) => file.folder.split('/').slice(0, 2).join('/')).filter(Boolean))].sort();

    return {
        storage: useS3() ? 's3' : 'disk',
        files: files.slice((page - 1) * limit, page * limit),
        folders,
        truncated: all.length >= MAX_FILES,
        pagination: { total: files.length, page, limit, pages: Math.ceil(files.length / limit) || 1 },
    };
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Where the database still refers to a file, or null. Searches every text,
 * varchar (long enough to hold the name), JSON and array column in the public
 * schema for the file's name.
 */
export async function findFileUsage(storedPath) {
    const name = path.posix.basename(cleanStoredPath(storedPath));
    if (name.length < 8) throw new ValidationError('That file name is too short to check safely');

    const columns = await prisma.$queryRaw`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name <> '_prisma_migrations'
           AND (data_type IN ('text', 'json', 'jsonb', 'ARRAY')
                OR (data_type = 'character varying'
                    AND (character_maximum_length IS NULL OR character_maximum_length >= ${name.length})))
         ORDER BY table_name, ordinal_position`;

    const byTable = new Map();
    for (const { table_name: table, column_name: column } of columns) {
        byTable.set(table, [...(byTable.get(table) || []), column]);
    }

    const needle = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    for (const [table, cols] of byTable) {
        const where = cols.map((col) => `${quoteIdent(col)}::text LIKE $1`).join(' OR ');
        const hit = await prisma.$queryRawUnsafe(
            `SELECT ${cols.map((col) => `(${quoteIdent(col)}::text LIKE $1) AS ${quoteIdent(col)}`).join(', ')}
               FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`,
            needle,
        );
        if (hit.length) {
            const column = Object.keys(hit[0]).find((key) => hit[0][key] === true) || cols[0];
            return { table, column };
        }
    }
    return null;
}

/** Delete a file nothing refers to; refuse, saying where, if something does. */
export async function deleteGalleryFile(storedPath) {
    const clean = cleanStoredPath(storedPath);
    const usage = await findFileUsage(clean);
    if (usage) {
        throw new ValidationError(`This file is still used (${usage.table}.${usage.column}). Remove it there first.`);
    }
    const removed = await deleteStoredFile(clean);
    if (!removed) throw new NotFoundError('File not found');
    return { path: clean, deleted: true };
}
