#!/usr/bin/env node
/**
 * Generates local dev secrets and writes/updates backend/.env
 * Does not overwrite existing non-placeholder secret values.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const SECRET_KEYS = [
  'JWT_SECRET',
  'WEBHOOK_SIGNING_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  'TELEGRAM_WEBHOOK_SECRET',
  'TRADINGVIEW_WEBHOOK_SECRET'
];

const PLACEHOLDER_PATTERNS = [
  /^your_/i,
  /^change_/i,
  /^demo_/i,
  /^placeholder/i,
  /^replace/i,
  /change-in-production/i,
  /^$/
];

function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function isPlaceholder(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(trimmed));
}

function parseEnv(content) {
  const lines = content.split(/\r?\n/);
  const map = new Map();

  for (const line of lines) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    map.set(key, value);
  }

  return map;
}

function serializeEnv(exampleContent, values) {
  const lines = exampleContent.split(/\r?\n/);
  const output = [];

  for (const line of lines) {
    if (!line.includes('=') || line.trim().startsWith('#')) {
      output.push(line);
      continue;
    }

    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (values.has(key)) {
      output.push(`${key}=${values.get(key)}`);
    } else {
      output.push(line);
    }
  }

  for (const key of SECRET_KEYS) {
    const alreadyPresent = output.some(row => row.startsWith(`${key}=`));
    if (!alreadyPresent && values.has(key)) {
      output.push(`${key}=${values.get(key)}`);
    }
  }

  return `${output.join('\n').replace(/\n?$/, '\n')}`;
}

function main() {
  const example = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  const existingContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const existing = parseEnv(existingContent);
  const generated = new Map(existing);

  for (const key of SECRET_KEYS) {
    const current = existing.get(key);
    if (!current || isPlaceholder(current)) {
      generated.set(key, generateSecret());
    }
  }

  const nextEnv = serializeEnv(example, generated);
  fs.writeFileSync(ENV_PATH, nextEnv, 'utf8');

  console.log(`Updated ${ENV_PATH}`);
  console.log('Generated or preserved secrets:');
  for (const key of SECRET_KEYS) {
    if (generated.has(key) && (!existing.get(key) || isPlaceholder(existing.get(key)))) {
      console.log(`  + ${key}`);
    } else if (generated.has(key)) {
      console.log(`  = ${key} (kept existing)`);
    }
  }
  console.log('\nPayment gateway API keys (PayPal, M-Pesa, etc.) are unchanged — add those when credentials arrive.');
}

main();
