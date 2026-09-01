#!/bin/sh
#
#  build-daemon.sh
#  cc-tokens
#
#  src/cli.ts を単一バイナリへ compile し、.app の Contents/MacOS に同梱する build phase。
#  これにより実行時は bun も cli.ts のパスも参照しない (bun が要るのはビルド時だけ)。
#
set -eu

REPO_ROOT="$SRCROOT/../.."
OUT="$BUILT_PRODUCTS_DIR/$EXECUTABLE_FOLDER_PATH/cctok-daemon"

# Xcode の PATH には mise の shim が乗らないので、bun の一般的な配置を明示的に探す。
for candidate in \
    "$(command -v bun || true)" \
    "$HOME/.local/share/mise/shims/bun" \
    "$HOME/.bun/bin/bun" \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun
do
    if [ -x "$candidate" ]; then
        BUN="$candidate"
        break
    fi
done

if [ -z "${BUN:-}" ]; then
    echo "error: bun not found. Install bun (https://bun.sh) to build the embedded daemon." >&2
    exit 1
fi

"$BUN" build --compile --outfile "$OUT" "$REPO_ROOT/src/cli.ts"

# bun の出力は adhoc 署名。nested code として app 本体と同じ identity で署名し直す。
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" "$OUT"
