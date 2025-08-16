#!/usr/bin/env bash
# AletheIA — Builder de artefatos para AWS Lambda
# ------------------------------------------------
# Gera zips prontos para deploy (Terraform/SAM) a partir de serviços em /services/*.
# Suporta dois modos:
#   1) Manifesto (recomendado): services/<svc>/lambda.manifest.json
#      {
#        "runtime": "nodejs20.x",
#        "functions": [
#          { "name": "ConnectFunction",   "entry": "src/ConnectFunction.js",   "handler": "index.handler" },
#          { "name": "disconnectWS",      "entry": "src/disconnectWS.js",      "handler": "index.handler" },
#          { "name": "GenerateChunk",     "entry": "src/GenerateChunk.js",     "handler": "index.handler" },
#          { "name": "PreparePrompt",     "entry": "src/PreparePrompt.js",     "handler": "index.handler" },
#          { "name": "SaveChatHistory",   "entry": "src/SaveChatHistory.js",   "handler": "index.handler" }
#        ]
#      }
#   2) Auto-descoberta (fallback): empacota todo *.js em services/<svc>/src/ como lambdas individuais
#      e assume handler "index.handler" em modo bundle.
#
# Requisitos: bash, zip, jq, Node.js 20+, npm. (esbuild é opcional; se presente, faz bundle.)
# Uso:
#   scripts/build-lambda.sh [--service <dir>|--all] [--mode bundle|zip] [--out <dir>] [--skip-install]
# Exemplos:
#   scripts/build-lambda.sh --all
#   scripts/build-lambda.sh --service services/chat-stream --mode bundle
#   scripts/build-lambda.sh --out dist/artifacts

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT_DIR="${ROOT_DIR}/dist/lambdas"
MODE="bundle"            # bundle (esbuild) | zip (copia src + node_modules)
TARGET_SERVICE=""
SKIP_INSTALL=false
RUNTIME="nodejs20.x"     # apenas descritivo (para manifest); handler padrão: index.handler

# --- Argumentos ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) TARGET_SERVICE="$2"; shift 2;;
    --all)     TARGET_SERVICE="__ALL__"; shift 1;;
    --out)     OUT_DIR="$2"; shift 2;;
    --mode)    MODE="$2"; shift 2;;
    --skip-install) SKIP_INSTALL=true; shift 1;;
    -h|--help)
      sed -n '1,80p' "$0"; exit 0;;
    *) echo "[erro] argumento desconhecido: $1"; exit 2;;
  esac
done

# --- Checagens ---
need() { command -v "$1" >/dev/null 2>&1 || { echo "[erro] requisito não encontrado: $1"; exit 3; }; }
need zip; need jq; need node; need npm

ESBUILD="npx --yes esbuild"
if [[ "$MODE" == "bundle" ]]; then
  if ! $ESBUILD --version >/dev/null 2>&1; then
    echo "[aviso] esbuild não disponível; trocando para modo 'zip' (sem bundle)."
    MODE="zip"
  fi
fi

mkdir -p "$OUT_DIR"
MANIFEST_OUT="$OUT_DIR/_build-manifest.json"
echo '{}' | jq '.' > "$MANIFEST_OUT"

# --- Funções auxiliares ---
json_append() {
  local file="$1" key="$2" json_value="$3"
  tmp="${file}.tmp"
  jq ".$key += [ $json_value ]" "$file" > "$tmp" && mv "$tmp" "$file"
}

build_node_bundle() {
  local svc_dir="$1" name="$2" entry="$3" handler="$4"
  local workdir="$svc_dir"
  local outbase="$OUT_DIR/$(basename "$svc_dir")/${name}"
  local builddir="$outbase/build"
  local zipfile="$outbase/${name}.zip"

  rm -rf "$builddir" && mkdir -p "$builddir"

  echo "[bundling] $name ← $entry"
  # Bundle único com esbuild (CJS) alvo node20; inclui dependências (não excluir @aws-sdk/*)
  $ESBUILD "$workdir/$entry" \
    --bundle \
    --platform=node \
    --target=node20 \
    --format=cjs \
    --outfile="$builddir/index.cjs" \
    --sourcemap=external \
    --minify

  # Zipa apenas o bundle + sourcemap
  (cd "$builddir" && zip -qr "$zipfile" index.cjs index.cjs.map)

  # SHA256 para integridade
  shasum -a 256 "$zipfile" | awk '{print $1}' > "$zipfile.sha256"

  json_append "$MANIFEST_OUT" artifacts \
    "{\"service\": \"$(basename "$svc_dir")\", \"name\": \"$name\", \"entry\": \"$entry\", \"mode\": \"bundle\", \"handler\": \"$handler\", \"zip\": \"${zipfile#${ROOT_DIR}/}\"}"
}

build_node_zip() {
  local svc_dir="$1" name="$2" entry="$3" handler="$4"
  local outbase="$OUT_DIR/$(basename "$svc_dir")/${name}"
  local stagedir="$outbase/stage"
  local zipfile="$outbase/${name}.zip"

  rm -rf "$stagedir" && mkdir -p "$stagedir"
  echo "[pack] $name (sem bundle) ← $entry"

  # Copia entry e demais fontes de apoio
  mkdir -p "$stagedir/src"
  rsync -a --exclude 'tests' --exclude '*.test.*' "$svc_dir/src/" "$stagedir/src/" 2>/dev/null || true

  # Instala só prod deps
  if [[ -f "$svc_dir/package.json" && "$SKIP_INSTALL" != true ]]; then
    (cd "$svc_dir" && if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi)
  fi
  if [[ -d "$svc_dir/node_modules" ]]; then
    rsync -a "$svc_dir/node_modules" "$stagedir/"
  fi

  # Handlers comuns: index.js aponta para o entry (CJS require)
  cat > "$stagedir/index.js" <<'EOF'
// Wrapper de handler padrão — requer o entry indicado por LAMBDA_ENTRY ou fallback
const path = process.env.LAMBDA_ENTRY || './src/handler.js';
const mod = require(path);
exports.handler = mod.handler || mod.default || (() => { throw new Error('Handler não encontrado'); });
EOF
  # Zipa tudo
  (cd "$stagedir" && zip -qr "$zipfile" .)
  shasum -a 256 "$zipfile" | awk '{print $1}' > "$zipfile.sha256"

  json_append "$MANIFEST_OUT" artifacts \
    "{\"service\": \"$(basename "$svc_dir")\", \"name\": \"$name\", \"entry\": \"$entry\", \"mode\": \"zip\", \"handler\": \"$handler\", \"zip\": \"${zipfile#${ROOT_DIR}/}\"}"
}

build_service() {
  local svc_dir="$1"
  [[ -d "$svc_dir" ]] || { echo "[skip] serviço inexistente: $svc_dir"; return; }

  echo "\n=== Serviço: $(basename "$svc_dir") ==="
  local manifest="$svc_dir/lambda.manifest.json"
  local has_manifest=false
  if [[ -f "$manifest" ]]; then has_manifest=true; fi

  # Instala dependências (uma vez) se for zip mode copiar node_modules
  if [[ "$MODE" == "zip" && -f "$svc_dir/package.json" && "$SKIP_INSTALL" != true ]]; then
    echo "[deps] instalando dependências prod em $(basename "$svc_dir")"
    (cd "$svc_dir" && if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi)
  fi

  if $has_manifest; then
    local count
    count=$(jq '.functions | length' "$manifest")
    if [[ "$count" -eq 0 ]]; then echo "[aviso] manifest sem funções: $manifest"; return; fi
    for i in $(seq 0 $((count-1))); do
      local name entry handler
      name=$(jq -r ".functions[$i].name" "$manifest")
      entry=$(jq -r ".functions[$i].entry" "$manifest")
      handler=$(jq -r ".functions[$i].handler // \"index.handler\"" "$manifest")
      [[ "$name" == "null" || "$entry" == "null" ]] && { echo "[erro] função inválida no manifest (name/entry)"; exit 4; }
      if [[ "$MODE" == "bundle" ]]; then
        build_node_bundle "$svc_dir" "$name" "$entry" "$handler"
      else
        build_node_zip "$svc_dir" "$name" "$entry" "$handler"
      fi
    done
  else
    echo "[fallback] manifest não encontrado; auto-descobrindo entries em $svc_dir/src/*.js"
    mapfile -t files < <(find "$svc_dir/src" -maxdepth 1 -type f -name '*.js' -printf '%f
' 2>/dev/null | sort)
    if [[ ${#files[@]} -eq 0 ]]; then echo "[skip] nenhum entry .js em $svc_dir/src"; return; fi
    for f in "${files[@]}"; do
      local name="${f%.js}"
      if [[ "$MODE" == "bundle" ]]; then
        build_node_bundle "$svc_dir" "$name" "src/$f" "index.handler"
      else
        build_node_zip "$svc_dir" "$name" "src/$f" "index.handler"
      fi
    done
  fi
}

# --- Seleção de serviços ---
services=( )
if [[ -n "$TARGET_SERVICE" && "$TARGET_SERVICE" != "__ALL__" ]]; then
  services=("$TARGET_SERVICE")
else
  # auto-lista serviços conhecidos (subpastas de /services)
  while IFS= read -r d; do services+=("$d"); done < <(find "$ROOT_DIR/services" -mindepth 1 -maxdepth 1 -type d | sort)
fi

# --- Execução ---
for s in "${services[@]}"; do
  build_service "$s"
done

echo "\n[ok] artefatos gerados em: ${OUT_DIR}"
if command -v tree >/dev/null 2>&1; then tree -h "$OUT_DIR" | sed 's/^/  /'; else find "$OUT_DIR" -type f | sed 's/^/  /'; fi

echo "\nManifesto de build: ${MANIFEST_OUT#${ROOT_DIR}/}"
cat "$MANIFEST_OUT" | jq '.artifacts | length as $n | {artifacts: $n}'

# Dicas de uso no Terraform (exemplo):
# module "lambda_generate_chunk" {
#   source  = "../modules/lambda_function"
#   name    = "generate-chunk"
#   runtime = "nodejs20.x"
#   handler = "index.handler"
#   zip_path = "${path.root}/../../dist/lambdas/chat-stream/GenerateChunk/GenerateChunk.zip"
# }
