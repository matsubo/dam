#!/usr/bin/env bash
# Fetch 国土数値情報 W05（河川）for all 47 prefectures plus the 水系域コード
# codelist into data/nlni/w05/, and unpack only the Stream attribute table
# (*_Stream.dbf) that apps/web/bin/classify_watershed_kind.ts reads.
#
#   bin/fetch_w05.sh            # → data/nlni/w05/
#   bin/fetch_w05.sh /other/dir
#
# Licence: W05 is 「非商用」 under the 旧国土情報利用約款準拠版 terms
# (https://nlftp.mlit.go.jp/ksj/other/agreement_02.html) — the same class
# as the W07 boundaries already in use. Only the derived per-watershed
# classification is committed; the archives stay in the gitignored data/.
set -euo pipefail

DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/data/nlni/w05}"
BASE="https://nlftp.mlit.go.jp/ksj/gml/data/W05"
mkdir -p "$DEST"

# File names carry the survey year (06=四国, 07=東北/北陸/九州, 08=関東/中部/中国, 09=北海道/近畿).
FILES="
W05-06_36 W05-06_37 W05-06_38 W05-06_39
W05-07_02 W05-07_03 W05-07_04 W05-07_05 W05-07_06 W05-07_07 W05-07_15 W05-07_16 W05-07_17 W05-07_18
W05-07_40 W05-07_41 W05-07_42 W05-07_43 W05-07_44 W05-07_45 W05-07_46 W05-07_47
W05-08_08 W05-08_09 W05-08_10 W05-08_11 W05-08_12 W05-08_13 W05-08_14 W05-08_19 W05-08_20 W05-08_21
W05-08_22 W05-08_23 W05-08_24 W05-08_31 W05-08_32 W05-08_33 W05-08_34 W05-08_35
W05-09_01 W05-09_25 W05-09_26 W05-09_27 W05-09_28 W05-09_29 W05-09_30
"

for stem in $FILES; do
  zip="${stem}_GML.zip"
  year="${stem:4:2}"
  if [ ! -s "$DEST/$zip" ]; then
    echo "fetching $zip"
    curl -sfL --retry 3 -o "$DEST/$zip.part" "$BASE/W05-$year/$zip"
    mv "$DEST/$zip.part" "$DEST/$zip"
    sleep 1
  fi
  unzip -o -q -j "$DEST/$zip" '*_Stream.dbf' -d "$DEST"
done

if [ ! -s "$DEST/WaterSystemCodeCd.html" ]; then
  curl -sfL -o "$DEST/WaterSystemCodeCd.html" \
    "https://nlftp.mlit.go.jp/ksj/gml/codelist/WaterSystemCodeCd.html"
fi

echo "stream tables: $(ls "$DEST"/*_Stream.dbf | wc -l | tr -d ' ') (expect 47)"
