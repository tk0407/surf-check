# 検索結果の共有（LINE / 画像）設計

作成日: 2026-09-20

## 目的

ランキングの結果を、LINEのトークにそのまま貼れる形で共有できるようにする。共有された側がリンクを開けば同じ結果を再現でき、画像だけを見ても内容が分かる状態にする。

## スコープ

**含む**

- ランキングタブの結果を対象にした「LINEで送る」ボタン
- 同じ結果を1枚の画像にして、共有（スマホ）または保存（PC）するボタン
- 検索条件を復元できる共有URL（`?region=&date=&slot=`）と、その読み込み対応

**含まない**

- 週間予報タブの共有（7日×3時間帯のグリッドは別の絵が必要になるため、今回は対象外）
- LINE以外のSNS向けの専用ボタン（画像の共有シート経由で他アプリにも渡せる）
- サーバー側でのOGP画像生成（静的サイトのままにする）

## 全体の制約

- 新しいパッケージを入れない。外部スクリプトも読み込まない（画像生成は `<canvas>` の2Dコンテキストのみで行う）。
- 画面に出す文字列は `escapeHtml` を通す。canvas に描く文字列はHTMLではないためエスケープ不要。
- 本番コードにテスト用の分岐を入れない。
- スマホ幅 375px でページが横スクロールしないこと。
- ランキングの取得・採点・カード描画の挙動は変更しない。
- `index.html` のアセット参照に付いている `?v=` の日付を、CSS / JS を変更したら上げる。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` を付ける。

## UI / 導線

ランキングの結果ヘッダー（`.results-head`）の直後に、共有ボタンの行を置く。

```
千葉北の朝（07-10時）ランキング          2026-09-20 / 10件
[ LINEで送る ]   [ 画像で共有 ]
```

- 表示条件: `renderResults` が1件以上のカードを描いたときだけ。結果0件、取得失敗のみ、初期の空状態、取得中には出さない。
- 週間予報タブでは出さない（`#weekly` には共有ボタンを描画しない）。
- 375px では2つのボタンが横に並ぶ（各ボタンは最小 44px 高、等幅）。
- ボタンは `<button type="button">`。リンクではないので新規タブの制御はJS側で行う。

「画像で共有」のラベルは、`navigator.canShare` でファイル共有が使えない環境では読み込み時に「**画像を保存**」へ変える。押したあとに動きが変わるのではなく、押す前に何が起きるか分かる状態にする。

## 共有カード（画像）

### 仕様

| 項目 | 値 |
| --- | --- |
| サイズ | 1080 × 1080 px（正方形） |
| 背景 | `#edf3f5`（`--bg`）、角丸なし |
| 文字色 | 見出し `#124559`（`--deep`）、本文 `#17212b`（`--ink`）、補足 `#687481`（`--muted`） |
| アクセント | 点数 `#007f8f`（`--sea`）、1位のバッジ `#124559` |
| フォント | `system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`（画面と同じ指定） |
| 形式 | PNG（`canvas.toBlob(cb, "image/png")`） |

### レイアウト

上下左右 64px の余白。上から順に:

1. `SURF CHECK`（12px相当を拡大した小見出し、`--sea`、字間広め）
2. `{エリア} / {M月D日(曜)} {時間帯ラベル}` — 例: `千葉北 / 9月20日(土) 朝 07-10時`
3. 区切り線（`#dce5eb`）
4. 上位3件。1件あたり 1つのブロック:
   - 左に順位バッジ（円、1位は `--deep` 塗り+白文字、2・3位は白塗り+`--deep` 文字）
   - ポイント名（太字）。長い名前は描画幅に収まるよう `…` で省略する
   - 右端に `54/85`（点数は大きく `--sea`、`/85` は小さく `--muted`）
   - 2行目に `1.4m カタ〜アタマ ・ 北東 5.5m/s サイドオフ`
5. 下部に `ほか{N}件`（`N` はヒット総件数から描いた件数を引いた数。0なら出さない）と `tk0407.github.io/surf-check`

### 件数が3件未満のとき

ヒットしたポイントが1件または2件のときは、その件数だけ描く。空いた領域は詰めず、レイアウトは上詰めのままにする（カードの高さは常に1080固定）。

### 元にする値

`renderResults` に渡る `results`（`scores.total` の降順で整列済み）の先頭3件を使う。1件あたり以下を参照する。

| 表示 | 取得元 |
| --- | --- |
| ポイント名 | `result.spot.name` |
| 点数 | `result.scores.total` |
| 波サイズ | `result.data.wave_height.toFixed(1)` + `Scoring.waveSizeLabel(result.data.wave_height)` |
| 風 | `jpDirection(result.data.wind_dir)` + `result.data.wind_speed.toFixed(1)` + `windConditionLabel(result.data.wind_dir, result.data.wind_speed, result.spot.bearing)` |

## 画像の共有と保存

```
押す
 ├ canvas に描画（1080×1080）
 ├ canvas.toBlob → PNG Blob
 ├ navigator.canShare({ files: [file] }) が true
 │    → navigator.share({ files: [file], text: <1行目 + 改行 + 共有URL> })
 └ それ以外
      → <a download> でダウンロード
```

- ファイル名: `surf-check-{region}-{date}-{slot}.png`（例: `surf-check-千葉北-2026-09-20-morning.png`）
- `navigator.share` に `url` フィールドは渡さない。画像とURLを同時に渡すと受け取り側で画像が落ちることがあるため、URLは `text` に含める。
- `navigator.share` がユーザーのキャンセルで reject した場合（`AbortError`）は何も表示しない。
- それ以外の失敗はボタンの下に `画像を作れませんでした` と1行出す（`.failed` の既存スタイル）。

## LINEで送る

### 文面

```
千葉北 9/20(土) 朝のサーフチェック
1位 飯岡 54点（1.4m / 北東5.5m/s サイドオフ）
2位 一宮 51点（2.1m / 北4.9m/s サイド）
3位 釣ヶ崎（志田下） 51点（2.1m / 北4.9m/s サイド）
https://tk0407.github.io/surf-check/?region=千葉北&date=2026-09-20&slot=morning
```

- 1行目: `{エリア} {M/D(曜)} {朝|昼|夕}のサーフチェック`
- 2行目以降: 上位3件（件数が少なければその数だけ）。`{順位}位 {名前} {点数}点（{波高}m / {風向}{風速}m/s {風のコンディション}）`
- 最終行: 共有URL。空行を1つ挟む。

### 送り方

`https://line.me/R/msg/text/?{encodeURIComponent(text)}` を `window.open(url, "_blank", "noopener")` で開く。スマホではLINEアプリ、PCではブラウザ版LINEが受け取る。

## 共有URL

### 形式

`{origin}{pathname}?region={エリア}&date={YYYY-MM-DD}&slot={morning|afternoon|evening}`

エリア名は日本語なので `URLSearchParams` でエンコードする。

### 読み込み時の扱い

`DOMContentLoaded` で `spots.json` を読んだ直後に、`location.search` を検証する。

| パラメータ | 通す条件 | 外れたとき |
| --- | --- | --- |
| `region` | `#region` の `<option>` の値に完全一致 | そのパラメータを無視（既定値のまま） |
| `date` | `YYYY-MM-DD` 形式で、実在する日付であること（`2026-13-45` は落とす） | そのパラメータを無視（今日のまま） |
| `slot` | `morning` / `afternoon` / `evening` のいずれか | そのパラメータを無視（既定値のまま） |

`date` は過去・未来を問わず、形式が正しければそのまま使う。数日後に共有リンクを開いた人は、送られた日の結果をそのまま見る。**1つでも有効なパラメータがあれば**、選択欄に反映したうえでランキングを自動実行する。1つも無ければ何もしない（従来どおり空状態から始まる）。

`initDate()` は `#date` に `min`（今日）と `max`（今日+9日）を入れている。URLで渡った日付がこの範囲の外だったときは、**その日付を含むように `min` または `max` を広げる**。入力欄の表示値と制約が食い違ったままにしないため。

Open-Meteo が受け付ける日付の範囲は marine と forecast で違い、風のデータは概ね92日前までしか取れない。それより古いリンクを開くと全ポイントの取得が失敗し、既存の「データを取得できませんでした。」が出る。これは想定内の挙動として受け入れ、専用のメッセージは作らない。

ランキングタブ以外のパラメータ（週間予報）は今回扱わない。

### 実行後のURL反映

`renderResults` が成功したあと、`history.replaceState` で現在の条件をURLに書く。履歴は増やさない。これにより、ブラウザのURL欄をコピーしても共有ボタンと同じリンクになる。

## モジュール構成

`forecast.js` と同じ UMD 形式（Node では `module.exports`、ブラウザでは `self.Share`）で `share.js` を新設する。読み込み順は `scoring.js` → `forecast.js` → `share.js` → `app.js`。

| 関数 | 引数 | 返り値 | 内容 |
| --- | --- | --- | --- |
| `shareLines(region, date, slot, results)` | 整列済み `results` | `string[]` | LINE文面の本文（1行目＋上位3件）。URLは含めない |
| `shareText(region, date, slot, results, url)` | 上記 + 共有URL | `string` | `shareLines` の結果と `url` を空行で連結した全文 |
| `shareUrl(base, region, date, slot)` | `base` は `origin + pathname` | `string` | クエリ付きURL |
| `parseParams(search, options)` | `search` は文字列、`options` は `{ regions, slots }` | `{ region?, date?, slot? }` | 検証を通ったものだけを含むオブジェクト。何も通らなければ空オブジェクト |
| `cardRows(results)` | 整列済み `results` | `{ rank, name, score, wave, wind }[]` | 画像とテキストが同じ値を使うための共通の整形。最大3件 |
| `drawShareCard(canvas, info)` | `info` は `{ region, date, slot, rows, count }`（`count` はヒットした総件数） | `void` | 1080×1080 に描画 |

`jpDirection` と `windConditionLabel` は現在 `app.js` にあり、`cardRows` から使う必要がある。**この2つを `share.js` に移し、`app.js` は `Share.jpDirection` / `Share.windConditionLabel` を参照する**（`conditionMetrics` も含めて呼び出し側を書き換える）。画面の表示結果は変えない。

## エラー処理

| 状況 | 振る舞い |
| --- | --- |
| 結果が0件 | 共有ボタンを表示しない |
| `navigator.share` のキャンセル（`AbortError`） | 何も表示しない |
| `navigator.share` のその他の失敗 | `画像を作れませんでした` を1行表示 |
| `canvas.toBlob` が null を返す | 同上 |
| `window.open` がブロックされた | `LINEを開けませんでした` を1行表示 |
| URLパラメータが不正 | 黙って無視し、既定値で表示する（警告は出さない） |
| 古すぎる日付でAPIが範囲外を返す | 全ポイントが取得失敗し、既存の「データを取得できませんでした。」が出る |

## テスト

`share.test.js` を追加し、`node --test` で既存の29件と一緒に走らせる。純粋関数のみを対象にする。

- `cardRows`: 4件以上渡すと3件に切る / 2件なら2件 / 0件なら空 / 波と風の文字列が仕様どおり組まれる
- `shareLines`: 1行目の書式、順位の採番、件数が1〜3件のときの行数
- `shareText`: 本文とURLが空行で連結される
- `shareUrl`: 日本語のエリア名がエンコードされる、3つのパラメータが揃う
- `parseParams`: 全部有効 / `region` が一覧に無い / 過去の日付が通る / 未来の日付が通る / `date` の形式違い（`2026-9-1`、`2026-13-45`）/ `slot` が不正 / クエリ無し
- `jpDirection` と `windConditionLabel`: 移設後も同じ値を返すこと（境界の角度を含む）

`drawShareCard` はブラウザAPIを使うためNodeのテスト対象にしない。ヘッドレスブラウザで実際にPNGを生成し、サイズと見た目を確認する。

## 確認方法

1. `node --test` が全件成功する
2. ランキングの取得・表示が従来と同じ（共有ボタンの行以外、描画HTMLに差が無い）
3. 共有URLを開くと、選択欄が復元されて自動でランキングが出る
4. 過去の日付のリンクを開くと、その日の結果が出る（数日前のリンクで確認する）
5. 不正なパラメータ（存在しないエリア、`2026-13-45`）で開いても既定値で正常に動く
6. 生成したPNGが1080×1080で、上位3件と条件が読める
7. 375px で横スクロールが出ない
