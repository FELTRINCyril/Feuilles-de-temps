#!/usr/bin/env node
/**
 * One-shot migration: the single "INTERNE" client, whose two activities were
 * really two companies (KREADDIS and GEMADDIS), becomes two internal clients
 * with activities of their own, deduced from each entry's description.
 *
 * Also backfills `customerId` on every other entry, so the whole history stops
 * depending on the activity to know its client.
 *
 * Usage:
 *   node scripts/split-interne-customer.mjs [dataDir]        # dry run
 *   node scripts/split-interne-customer.mjs [dataDir] --write
 *
 * Quit the app first: it holds the same files.
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(process.env.HOME, 'Library/Application Support/com.timesheet.tracker');
const WRITE = process.argv.includes('--write');

const OLD_CUSTOMER = 'INTERNE';

/**
 * Ordered rules: the first pattern that matches a description names the
 * activity. Order matters — "étiquette" outranks "rapport" because the label
 * work is its own long-running thread, and a ticket is a ticket whatever it is
 * about. Anything unmatched lands in "Divers" and is listed at the end for a
 * human to re-file.
 */
const RULES = {
  KREADDIS: [
    // A description opening on "Point avec ..." is a meeting whatever it is
    // about, so this outranks the topic rules below.
    [/^point |^r[eé]union|r[eé]union sur|participation [aà] la r[eé]union/i, 'Réunion'],
    [/formation|autoformation/i, 'Formation'],
    [/alternance|tetras|synth[eè]se (en )?entreprise|periode de cours/i, 'Alternance'],
    [/qualiopi|\bcv\b|fiche formateur/i, 'Qualiopi'],
    [/gestion interne|gestion des mails|triage des mails|reprise|projets? en cours/i, 'Gestion interne'],
    [/analyse|investigation/i, 'Analyse'],
    [/claude code|finder|stockage|environnement de travail|feuille de temps|saisie des timesheets|config claude/i, 'Outillage'],
    [/iot/i, 'R&D'],
    [/aide|explication|participation|tickets/i, 'Support'],
  ],
  GEMADDIS: [
    // Narrow on purpose: a passing "(Ticket de Thomas)" at the end of a long
    // entry does not make the whole entry ticket work.
    [/^ticket|ticket \d+|du ticket de/i, 'Tickets'],
    [/aide (imen|g[eé]rard|yoenie)|explication et aide/i, 'Support'],
    [/excalidraw|clarification des besoins|v[eé]rification des contacts|r[eé]cup[eé]ration des besoins/i, 'Analyse'],
    [/[eé]tiquette/i, 'Etiquettes'],
    [/^validation du workflow|^point avec/i, 'Réunion'],
    [/rapport|bon de livraison|facture|fr\/out|\bbl\b|nomenclature|bon de commande|comptabilit[eé]|pdf_reports/i, 'Rapport PDF'],
    [/module|gemaddis_|d[eé]veloppement|mod[eè]le d|date limite|envoi automatique|mise en production/i, 'Dev'],
  ],
};

const FALLBACK = 'Divers';

const uuid = () => crypto.randomUUID();
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf-8'));

async function writeJson(p, data) {
  if (!WRITE) return;
  const tmp = `${p}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, p);
}

function classify(company, description) {
  for (const [pattern, activity] of RULES[company]) {
    if (pattern.test(description)) return activity;
  }
  return FALLBACK;
}

async function main() {
  const customers = await readJson(path.join(DATA_DIR, 'customers.json'));
  const activities = await readJson(path.join(DATA_DIR, 'activities.json'));

  const old = customers.customers.find((c) => c.name === OLD_CUSTOMER);
  if (!old) throw new Error(`Client "${OLD_CUSTOMER}" introuvable`);

  // The two activities that were really companies.
  const companyActivities = {};
  for (const a of activities.activities) {
    if (a.customerId === old.id && RULES[a.name]) companyActivities[a.id] = a.name;
  }
  const strays = activities.activities.filter(
    (a) => a.customerId === old.id && !RULES[a.name],
  );
  if (strays.length) {
    throw new Error(
      `Activités inattendues sous ${OLD_CUSTOMER} : ${strays.map((a) => a.name).join(', ')}`,
    );
  }

  // New clients, both internal.
  const newCustomers = {};
  for (const name of Object.keys(RULES)) {
    newCustomers[name] = { id: uuid(), name, type: 'interne' };
  }

  // Pass 1: classify, so only the activities actually needed get created.
  const dates = (await fs.readdir(DATA_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  const plan = [];       // { date, entry, company, activityName }
  const backfill = [];   // entries that only need customerId filled in
  const activityByKey = new Map(); // `${company}|${name}` -> id

  for (const file of dates) {
    const day = await readJson(path.join(DATA_DIR, file));
    for (const entry of day.entries) {
      const company = companyActivities[entry.activityId];
      if (company) {
        const activityName = classify(company, entry.description ?? '');
        activityByKey.set(`${company}|${activityName}`, null);
        plan.push({ date: file.slice(0, -5), entry, company, activityName });
      } else if (entry.customerId === undefined) {
        backfill.push({ date: file.slice(0, -5), entry });
      }
    }
  }

  for (const key of activityByKey.keys()) {
    const [company, name] = key.split('|');
    activityByKey.set(key, uuid());
    activities.activities.push({
      id: activityByKey.get(key),
      name,
      customerId: newCustomers[company].id,
    });
  }

  // Pass 2: rewrite the day files.
  const counts = {};
  const unmatched = [];
  for (const file of dates) {
    const filePath = path.join(DATA_DIR, file);
    const day = await readJson(filePath);
    let touched = false;

    for (const entry of day.entries) {
      const company = companyActivities[entry.activityId];
      if (company) {
        const activityName = classify(company, entry.description ?? '');
        entry.customerId = newCustomers[company].id;
        entry.activityId = activityByKey.get(`${company}|${activityName}`);
        counts[`${company} / ${activityName}`] = (counts[`${company} / ${activityName}`] ?? 0) + 1;
        if (activityName === FALLBACK) {
          unmatched.push(`${file.slice(0, -5)} ${company} | ${(entry.description ?? '').slice(0, 80)}`);
        }
        touched = true;
      } else if (entry.customerId === undefined) {
        // Freeze the client that was until now merely derived from the activity.
        entry.customerId = activities.activities.find((a) => a.id === entry.activityId)?.customerId ?? '';
        touched = true;
      }
    }

    if (touched) await writeJson(filePath, day);
  }

  // The old client and its two company-activities have no users left.
  activities.activities = activities.activities.filter((a) => a.customerId !== old.id);
  customers.customers = customers.customers.filter((c) => c.id !== old.id);
  customers.customers.push(...Object.values(newCustomers));

  await writeJson(path.join(DATA_DIR, 'activities.json'), activities);
  await writeJson(path.join(DATA_DIR, 'customers.json'), customers);

  console.log(WRITE ? '=== MIGRATION APPLIQUEE ===' : '=== SIMULATION (rien ecrit) ===');
  console.log(`Dossier    : ${DATA_DIR}`);
  console.log(`Jours lus  : ${dates.length}`);
  console.log(`Entrees migrees  : ${plan.length}`);
  console.log(`Entrees backfill : ${backfill.length} (customerId fige depuis l'activite)`);
  console.log('\nRepartition :');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${String(v).padStart(3)}  ${k}`);
  if (unmatched.length) {
    console.log(`\nA reclasser a la main (${unmatched.length} en "${FALLBACK}") :`);
    for (const u of unmatched) console.log(`  ${u}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
