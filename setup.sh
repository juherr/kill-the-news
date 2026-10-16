#!/usr/bin/env bash

set -euo pipefail

echo "🚀 Setting up kill-the-news..."

if ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Node.js (with npm and npx) is required but not found."
  echo "Install Node.js from https://nodejs.org/en/download/ and run setup again."
  exit 1
fi

if [ ! -f "wrangler-example.toml" ]; then
  echo "❌ Error: wrangler-example.toml not found."
  exit 1
fi

WORKER_NAME="$(grep -E '^name = "' wrangler-example.toml | head -1 | cut -d'"' -f2)"
if [ -z "$WORKER_NAME" ]; then
  WORKER_NAME="kill-the-news"
fi

echo "📦 Installing dependencies..."
npm install

echo "🔒 Checking Cloudflare authentication..."
set +e
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
WHOAMI_STATUS=$?
set -e
if [ "$WHOAMI_STATUS" -ne 0 ] || echo "$WHOAMI_OUTPUT" | grep -qi "not authenticated"; then
  echo "❌ You are not logged in to Cloudflare. Please run:"
  echo "npx wrangler login"
  echo "After login completes, run this setup script again."
  exit 1
fi
echo "✅ Cloudflare authentication verified"

extract_namespace_ids_from_json() {
  local worker_name="$1"
  # Template literals below are expanded by JavaScript, not the shell.
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const workerName = process.argv[1];

let namespaces;
try {
  namespaces = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  console.error("❌ Wrangler returned invalid namespace JSON.");
  process.exit(1);
}

if (!Array.isArray(namespaces)) {
  console.error("❌ Expected a JSON array of KV namespaces from Wrangler.");
  process.exit(1);
}

const findByTitle = (title) => {
  const match = namespaces.find((namespace) => namespace?.title === title && typeof namespace?.id === "string");
  return match?.id ?? "";
};

const mainId = findByTitle(`${workerName}-EMAIL_STORAGE`);
const previewId = findByTitle(`${workerName}-EMAIL_STORAGE_preview`);
process.stdout.write(`${mainId}\n${previewId}`);
' "$worker_name"
}

get_kv_namespace_ids() {
  echo "🔍 Retrieving KV namespace IDs..."

  local output
  # Suppress Wrangler's skills notice so stdout contains only namespace JSON.
  if ! output="$(CI=true npx wrangler kv namespace list)"; then
    echo "❌ Error listing KV namespaces. See the Wrangler error above."
    return 1
  fi

  local ids
  if ! ids="$(printf '%s' "$output" | extract_namespace_ids_from_json "$WORKER_NAME")"; then
    return 1
  fi
  MAIN_ID="$(printf '%s\n' "$ids" | sed -n '1p')"
  PREVIEW_ID="$(printf '%s\n' "$ids" | sed -n '2p')"

  return 0
}

create_kv_namespace() {
  local output
  if ! output="$(npx wrangler kv namespace create "$@" 2>&1)"; then
    # Re-running setup should reuse namespaces that already exist.
    if ! printf '%s' "$output" | grep -qi "already exists"; then
      printf '❌ Failed to create KV namespace:\n%s\n' "$output" >&2
      return 1
    fi
  fi
}

get_kv_namespace_ids

if [ -z "$MAIN_ID" ] || [ -z "$PREVIEW_ID" ]; then
  echo "🗄️ Creating missing KV namespaces..."
  if [ -z "$MAIN_ID" ]; then
    create_kv_namespace "${WORKER_NAME}-EMAIL_STORAGE"
  fi
  if [ -z "$PREVIEW_ID" ]; then
    create_kv_namespace "${WORKER_NAME}-EMAIL_STORAGE" --preview
  fi
  get_kv_namespace_ids
fi

if [ -z "$MAIN_ID" ] || [ -z "$PREVIEW_ID" ]; then
  echo "❌ Failed to extract KV namespace IDs. Please run manually:"
  echo "npx wrangler kv namespace list"
  echo "And update the IDs in wrangler.toml"
  exit 1
fi

echo "📊 KV Namespace Status:"
echo "  ✅ Main KV namespace ID: $MAIN_ID"
echo "  ✅ Preview KV namespace ID: $PREVIEW_ID"

echo "🔐 Setting up admin password..."
read -r -p "Enter admin password: " admin_password
if [ -z "$admin_password" ]; then
  echo "❌ No admin password provided."
  exit 1
fi

set +e
SECRET_OUTPUT="$(printf '%s' "$admin_password" | npx wrangler secret put ADMIN_PASSWORD --env production --name "$WORKER_NAME" 2>&1)"
SECRET_STATUS=$?
set -e
if [ "$SECRET_STATUS" -ne 0 ]; then
  echo "❌ Failed to set admin password for production environment"
  echo "Error: $SECRET_OUTPUT"
  exit 1
fi
echo "✅ Admin password set for production environment"

read -r -p "Enter your domain (e.g., yourdomain.com): " domain
domain="${domain#https://}"
domain="${domain#http://}"
domain="${domain%%/*}"
if [ -z "$domain" ]; then
  echo "❌ No domain provided. Cannot continue."
  exit 1
fi
echo "✅ Domain: $domain"

ENABLE_R2=false
R2_BUCKET=""
R2_PREVIEW_BUCKET=""
read -r -p "Enable email attachments stored in R2? [y/N]: " enable_r2
if [[ "$enable_r2" =~ ^[Yy]$ ]]; then
  R2_BUCKET="${WORKER_NAME}-attachments"
  R2_PREVIEW_BUCKET="${R2_BUCKET}-preview"
  echo "🪣 Creating R2 buckets..."
  set +e
  R2_OUT="$(npx wrangler r2 bucket create "$R2_BUCKET" 2>&1)"
  R2_STATUS=$?
  R2_PREVIEW_OUT="$(npx wrangler r2 bucket create "$R2_PREVIEW_BUCKET" 2>&1)"
  R2_PREVIEW_STATUS=$?
  set -e
  # An existing bucket is fine; only treat real failures as blocking.
  echo "$R2_OUT" | grep -qi "already exists" && R2_STATUS=0
  echo "$R2_PREVIEW_OUT" | grep -qi "already exists" && R2_PREVIEW_STATUS=0
  if [ "$R2_STATUS" -eq 0 ] && [ "$R2_PREVIEW_STATUS" -eq 0 ]; then
    ENABLE_R2=true
    echo "  ✅ R2 bucket: $R2_BUCKET"
    echo "  ✅ R2 preview bucket: $R2_PREVIEW_BUCKET"
  else
    echo "  ⚠️  Could not create R2 buckets (is R2 enabled on your account?)."
    echo "      Attachments will stay disabled — see INSTALL.md → 'Email attachments (R2)'."
    echo "$R2_OUT"
  fi
fi

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

KV_ID_ESCAPED="$(escape_sed_replacement "$MAIN_ID")"
KV_PREVIEW_ID_ESCAPED="$(escape_sed_replacement "$PREVIEW_ID")"
DOMAIN_ESCAPED="$(escape_sed_replacement "$domain")"
COMPATIBILITY_DATE_ESCAPED="$(escape_sed_replacement "$(date +%F)")"

echo "📝 Creating and configuring wrangler.toml..."
cp wrangler-example.toml wrangler.toml

if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/REPLACE_WITH_YOUR_DOMAIN/$DOMAIN_ESCAPED/g" wrangler.toml
  sed -i '' "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID_ESCAPED/g" wrangler.toml
  sed -i '' "s/REPLACE_WITH_YOUR_PREVIEW_KV_NAMESPACE_ID/$KV_PREVIEW_ID_ESCAPED/g" wrangler.toml
  sed -i '' "s/REPLACE_WITH_COMPATIBILITY_DATE/$COMPATIBILITY_DATE_ESCAPED/g" wrangler.toml
else
  sed -i "s/REPLACE_WITH_YOUR_DOMAIN/$DOMAIN_ESCAPED/g" wrangler.toml
  sed -i "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID_ESCAPED/g" wrangler.toml
  sed -i "s/REPLACE_WITH_YOUR_PREVIEW_KV_NAMESPACE_ID/$KV_PREVIEW_ID_ESCAPED/g" wrangler.toml
  sed -i "s/REPLACE_WITH_COMPATIBILITY_DATE/$COMPATIBILITY_DATE_ESCAPED/g" wrangler.toml
fi

if [ "$ENABLE_R2" = true ]; then
  echo "🔗 Enabling R2 attachment binding in wrangler.toml..."
  node - "wrangler.toml" "$R2_BUCKET" "$R2_PREVIEW_BUCKET" <<'NODE'
const fs = require("node:fs");
const [file, bucket, previewBucket] = process.argv.slice(2);
let txt = fs.readFileSync(file, "utf8");
txt = txt.split("REPLACE_WITH_YOUR_PREVIEW_BUCKET_NAME").join(previewBucket);
txt = txt.split("REPLACE_WITH_YOUR_BUCKET_NAME").join(bucket);
// Uncomment the commented r2_buckets blocks (global + [env.production]).
txt = txt.replace(
  /# r2_buckets = \[\n#(\s+\{ binding = "ATTACHMENT_BUCKET".*\})\n# \]/g,
  'r2_buckets = [\n$1\n]',
);
fs.writeFileSync(file, txt);
NODE
  echo "  ✅ ATTACHMENT_BUCKET bound to $R2_BUCKET"
fi

echo "✅ wrangler.toml has been created and configured successfully!"
echo ""
echo "✅ Setup complete! Next steps:"
echo "1. Configure email ingestion — Cloudflare Email Workers or ForwardEmail (see INSTALL.md for details)"
echo "2. Deploy with 'npm run deploy'"
