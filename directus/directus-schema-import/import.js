#!/usr/bin/env node
/**
 * import.js — ADDITIVE schema import
 *
 * Reads a Directus schema snapshot (YAML) and CREATES anything that is
 * missing from the live instance — collections, fields, relations.
 *
 * It NEVER deletes or modifies existing objects. That is the core
 * difference vs `schema apply`, which treats the snapshot as the FULL
 * desired end-state: anything live but absent from the snapshot gets
 * DELETED (see apply-diff.js / deleteCollections).
 *
 * Usage:
 *   node directus-schema-import/import.js                 # uses ../schema.yaml
 *   SNAPSHOT=snap.yaml node directus-schema-import/import.js
 *   DIRECTUS_URL=http://localhost:8055 node directus-schema-import/import.js
 *
 * Credentials come from ../.env (ADMIN_EMAIL / ADMIN_PASSWORD).
 */
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = process.env.SNAPSHOT || path.join(ROOT, 'schema.yaml');
const BASE = process.env.DIRECTUS_URL || 'http://localhost:8055';

function loadEnv() {
    const out = {};
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}

async function main() {
    const env = loadEnv();
    const snapshot = yaml.load(fs.readFileSync(SNAPSHOT, 'utf8'));

    console.log(`[import] snapshot : ${SNAPSHOT}`);
    console.log(`[import] base URL : ${BASE}`);

    // ---- authenticate ----------------------------------------------------
    const loginRes = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    });
    const loginBody = await loginRes.json();
    if (!loginRes.ok) {
        console.error(`[import] LOGIN FAILED (${loginRes.status}) — check ADMIN_EMAIL/ADMIN_PASSWORD in .env`);
        console.error(JSON.stringify(loginBody));
        process.exit(1);
    }
    const headers = {
        Authorization: `Bearer ${loginBody.data.access_token}`,
        'Content-Type': 'application/json',
    };

    // ---- read current live state ----------------------------------------
    const [colRes, fldRes, relRes] = await Promise.all([
        fetch(`${BASE}/collections?limit=-1`, { headers }),
        fetch(`${BASE}/fields?limit=-1`, { headers }),
        fetch(`${BASE}/relations?limit=-1`, { headers }),
    ]);
    const existingCollections = new Set((await colRes.json()).data.map((c) => c.collection));
    const existingFields = new Set();
    const rawFields = (await fldRes.json()).data; // flat array: [{collection, field, ...}]
    for (const f of rawFields) existingFields.add(`${f.collection}.${f.field}`);
    const existingRelations = new Set((await relRes.json()).data.map((r) => `${r.collection}.${r.field}`));

    let createdCollections = 0, createdFields = 0, createdRelations = 0;
    let existingCollectionsKept = 0, existingFieldsKept = 0, existingRelationsKept = 0;
    const errors = [];

    // ---- collections (skip system collections) ---------------------------
    const system = (name) => name.startsWith('directus_');
    for (const c of snapshot.collections) {
        if (system(c.collection)) continue;
        const exists = existingCollections.has(c.collection);
        if (exists) {
            existingCollectionsKept++;
            continue;
        }
        const payload = { collection: c.collection, meta: c.meta, ...(c.schema ? { schema: c.schema } : {}) };
        const res = await fetch(`${BASE}/collections`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (res.ok) {
            createdCollections++;
            existingCollections.add(c.collection); // fields for it below are now "existing collection"
            console.log(`  + collection ${c.collection}`);
        } else {
            errors.push(`collection ${c.collection}: ${res.status} ${(await res.json()).errors?.[0]?.message ?? ''}`);
        }
    }

    // ---- fields ----------------------------------------------------------
    for (const f of snapshot.fields) {
        if (system(f.collection)) continue;
        const key = `${f.collection}.${f.field}`;
        if (existingFields.has(key)) {
            existingFieldsKept++;
            continue;
        }
        if (!existingCollections.has(f.collection)) {
            errors.push(`field ${key}: collection ${f.collection} does not exist (create it first)`);
            continue;
        }
        const { collection, ...fieldPayload } = f; // drop the `collection` key — API infers it
        const res = await fetch(`${BASE}/fields/${f.collection}`, { method: 'POST', headers, body: JSON.stringify(fieldPayload) });
        if (res.ok) {
            createdFields++;
            existingFields.add(key);
            console.log(`  + field ${key}`);
        } else {
            const body = await res.json();
            const msg = body.errors?.[0]?.message ?? '';
            // Directus auto-creates the collection's primary key (e.g. `id`),
            // so a duplicate create is a no-op, not an error.
            if (msg.toLowerCase().includes('already exists')) {
                existingFieldsKept++;
                console.log(`  = field ${key} (already created with the collection)`);
            } else {
                errors.push(`field ${key}: ${res.status} ${msg}`);
            }
        }
    }

    // ---- relations -------------------------------------------------------
    for (const r of snapshot.relations) {
        if (system(r.collection)) continue;
        const key = `${r.collection}.${r.field}`;
        if (existingRelations.has(key)) {
            existingRelationsKept++;
            continue;
        }
        const payload = { collection: r.collection, field: r.field, related_collection: r.related_collection, meta: r.meta, schema: r.schema };
        const res = await fetch(`${BASE}/relations`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (res.ok) {
            createdRelations++;
            existingRelations.add(key);
            console.log(`  + relation ${key} → ${r.related_collection}`);
        } else {
            errors.push(`relation ${key}: ${res.status} ${(await res.json()).errors?.[0]?.message ?? ''}`);
        }
    }

    // ---- report ----------------------------------------------------------
    console.log('\n================ ADDITIVE IMPORT SUMMARY ================');
    console.log(`Collections : ${existingCollectionsKept} already present, ${createdCollections} created`);
    console.log(`Fields      : ${existingFieldsKept} already present, ${createdFields} created`);
    console.log(`Relations   : ${existingRelationsKept} already present, ${createdRelations} created`);
    console.log(`Removed     : 0  (import is additive-only)            ⬅ no DELETE ever happens`);
    if (errors.length) {
        console.log(`\n${errors.length} error(s):`);
        for (const e of errors) console.log(`  ! ${e}`);
    }
    console.log('==========================================================');
}

main().catch((err) => {
    console.error('[import] FATAL:', err);
    process.exit(1);
});