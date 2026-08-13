import pkg from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';

// DbNull writes SQL NULL to a Json column; a bare null would store JSON `null`.
const { Prisma } = pkg;
import { ValidationError } from '../../../../core/auth/errors.js';

const normalizeKey = (key) => String(key || '').trim().toLowerCase();

const decodeHtmlEntities = (value) => {
    if (value === null || value === undefined) return value;
    let s = String(value);
    if (!s.includes('&')) return s;
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
};

const normalizeLegalForResponse = (legal) => {
    if (!legal || typeof legal !== 'object') return legal;
    const title = legal.title ?? '';
    const content = decodeHtmlEntities(legal.content ?? '');
    const email = legal.email ?? '';
    const mobile = legal.mobile ?? '';
    return { ...legal, title, content, email, mobile };
};

const normalizeAboutForResponse = (about) => {
    if (!about || typeof about !== 'object') return about;
    return {
        ...about,
        appName: decodeHtmlEntities(about.appName ?? ''),
        version: decodeHtmlEntities(about.version ?? ''),
        description: decodeHtmlEntities(about.description ?? ''),
        logo: decodeHtmlEntities(about.logo ?? '')
    };
};

export const getPublicPageByKey = async (key, module = 'ALL') => {
    const k = normalizeKey(key);
    const m = String(module || 'ALL').toUpperCase();
    
    // The module-specific page wins; 'ALL' is the shared fallback. Both are
    // fetched in one round trip and picked in JS rather than two sequential
    // queries where the second only runs on a miss.
    const docs = await prisma.foodPageContent.findMany({
        where: { key: k, module: m === 'ALL' ? 'ALL' : { in: [m, 'ALL'] } },
    });
    const doc = docs.find((d) => d.module === m) || docs.find((d) => d.module === 'ALL') || null;
    
    if (!doc) return { key: k, module: m, data: null };
    if (k === 'about') return { key: k, module: m, data: normalizeAboutForResponse(doc.about || null) };
    return { key: k, module: m, data: normalizeLegalForResponse(doc.legal || null) };
};

export const getAdminPageByKey = async (key, module = 'ALL') => getPublicPageByKey(key, module);

export const upsertLegalPage = async (key, payload, updatedBy, module = 'ALL') => {
    const k = normalizeKey(key);
    const m = String(module || 'ALL').toUpperCase();
    if (!['terms', 'privacy', 'refund', 'shipping', 'cancellation', 'support'].includes(k)) {
        throw new ValidationError('Invalid page key');
    }
    const title = String(payload?.title || '').trim();
    const content = decodeHtmlEntities(String(payload?.content || '')).trim();
    const email = String(payload?.email || '').trim();
    const mobile = String(payload?.mobile || '').trim();

    // legal and about are alternatives on one row; writing one clears the other
    // so a page cannot answer as both.
    const data = {
        legal: { title, content, email, mobile },
        about: Prisma.DbNull,
        updatedBy: updatedBy ? String(updatedBy) : null,
        updatedByRole: 'ADMIN',
    };
    const doc = await prisma.foodPageContent.upsert({
        where: { key_module: { key: k, module: m } },
        create: { key: k, module: m, ...data },
        update: data,
    });

    return { key: k, module: m, data: normalizeLegalForResponse(doc?.legal || null) };
};

export const upsertAboutPage = async (payload, updatedBy, module = 'ALL') => {
    const m = String(module || 'ALL').toUpperCase();
    const appName = decodeHtmlEntities(String(payload?.appName || '')).trim() || 'Switcheats';
    const version = decodeHtmlEntities(String(payload?.version || '')).trim() || '1.0.0';
    const description = decodeHtmlEntities(String(payload?.description || '')).trim();
    const logo = decodeHtmlEntities(String(payload?.logo || '')).trim();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    const stats = Array.isArray(payload?.stats) ? payload.stats : [];

    const normalizedFeatures = features.map((f, idx) => ({
        icon: String(f?.icon || 'Heart'),
        title: String(f?.title || ''),
        description: String(f?.description || ''),
        color: String(f?.color || ''),
        bgColor: String(f?.bgColor || ''),
        order: Number.isFinite(Number(f?.order)) ? Number(f.order) : idx
    }));

    const data = {
        about: { appName, version, description, logo, features: normalizedFeatures, stats },
        legal: Prisma.DbNull,
        updatedBy: updatedBy ? String(updatedBy) : null,
        updatedByRole: 'ADMIN',
    };
    const doc = await prisma.foodPageContent.upsert({
        where: { key_module: { key: 'about', module: m } },
        create: { key: 'about', module: m, ...data },
        update: data,
    });

    return { key: 'about', module: m, data: normalizeAboutForResponse(doc?.about || null) };
};

