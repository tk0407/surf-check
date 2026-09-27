# 実況フィードバックと予報の補正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ランキングのカードから、実際に行った結果（総合・波・風・写真）を最短2タップで送れるようにする。貯まった予実データから、ポイントごとの予報の癖とランキングの配点を補正する。

**Architecture:**
- サイトは今のまま GitHub Pages の静的ファイルで、ビルドはしない。
- 補正の計算（`calibration.js`）と、記録の組み立て・入力チェック（`feedback.js`）は UMD で書く。サイト、Cloudflare Worker、`node --test` の3か所で同じファイルを使う。
- Worker（`worker/`）は次の2つを受け持つ。
  - `POST /feedback`：記録を D1 に、写真を R2 に保存する。R2 に書く前に、上限の判定と数え上げを D1 の1つのトランザクションで済ませる（`worker/quota.mjs`）。上限に当たった写真や非常停止中の写真は置かず、記録だけ保存する。
  - `GET /calibration`：記録からその都度、補正を計算して返す。
- サイトは起動時に補正を読み、`scoring.js` の上に重ねてかける。`scoring.js` は変えない。

**Tech Stack:**
- 素の JavaScript（UMD、ビルドなし）
- Node v23 の `node --test`。`node:sqlite` はテストでだけ使う。
- Cloudflare Workers + D1 + R2。`npx wrangler@4` は開発ツールとして使い、`package.json` は作らない。
- 画面の確認：ヘッドレス Chrome を CDP で直接動かす。パッケージは入れない。

**Spec:** `docs/superpowers/specs/2026-09-23-feedback-calibration-design.md`

## Global Constraints

- サイトは今のまま GitHub Pages に置く。ビルド工程を増やさない。サイト側に新しいパッケージを入れない。外部スクリプトを読み込まない。
- Worker も依存パッケージを持たない。`wrangler` は開発ツールとして `npx wrangler@4` で使う。`package.json` は作らない。**初めて `npx wrangler` を実行する前に、ユーザーの承認を得る。**
- `scoring.js` は変更しない。Python版が正本のしきい値を保つため。補正は `calibration.js` の上乗せ層で行う。
- 補正の計算には、必ず補正前の生の予報値を使う。補正が自分の出力を学び直して偏らないようにするため。
- 補正が無いとき（取得の失敗を含む）のランキング・週間予報・共有の表示と点数は、今とまったく同じになること。
- 本番コードにテスト用の分岐を入れない。テストは `node --test` だけで動かす。
- `app.js` の `FEEDBACK_API` が空文字のときは、補正を取りに行かず、「行ってきた」ボタンも出さない。Worker を公開する前にマージしても、サイトは今と同じに動く。
- 画面に出す文字列は `escapeHtml` を通す。
- スマホ幅 375px で、ページも入力パネルも横スクロールしない。
- `index.html` のアセット参照の `?v=` の日付を上げる。
- 秘密情報（`IP_SALT`、Cloudflare の認証情報）は、リポジトリにも markdown にも書かない。
- R2 に書くのは Worker の `POST /feedback` だけ。書く前に必ず、上限の判定と数え上げを D1 の1つのトランザクションで済ませる。この判定を通らずに R2 へ届く道を作らない。設定が読めないときは、何も保存しないか写真を置かない側に倒す。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

仕様には書いていないが、実際に使うと起きやすい入力と、そのとき期待する振る舞い。起きやすい順に並べた。どれも、担当するタスクのテストで確かめる。

1. **日本時間の0時をまたぐ時刻を、UTC の時計で扱う**
   - 起きる場面：Worker は UTC で動く。端末のタイムゾーンが日本以外のこともある。
   - 期待する振る舞い：パネルの初期の日付・時間帯と、1日の回数上限を数え直す日は、日本時間の日付で決まる。
   - テスト：Task 2 の `defaultSession uses Japan time on a UTC clock across midnight`、Task 4 の `limits restart at midnight Japan time even though the clock is UTC`
2. **壊れた送信**
   - 起きる場面：`record` が JSON でない、`record` 欄が無い、本文が multipart でない。
   - 期待する振る舞い：`500` ではなく、理由を付けた `400` を返す。
   - テスト：Task 4 の `malformed bodies get 400, not 500`
3. **ビッグエンディアン（Motorola）の EXIF**
   - 起きる場面：一部の Android 端末やカメラが、この形で書く。
   - 期待する振る舞い：リトルエンディアンのものと同じ撮影時刻・撮影位置が読める。
   - テスト：Task 2 の `readExif reads big-endian (Motorola) EXIF the same way`
4. **予報の風が弱いポイントに、大きなマイナスの風速補正がかかる**
   - 期待する振る舞い：補正後の風速は 0 m/s を下回らない。採点に負の風速が渡らない。
   - テスト：Task 1 の `adjust never pushes the wind speed below 0`
5. **長く動かし続けたときの `submissions` の肥大**
   - 期待する振る舞い：3日より古い行は、送信のたびに消える。
   - テスト：Task 4 の `each submission purges submission rows older than 3 days`

## 仕様からの変更点と補足

実装して確かめた結果、仕様と違う形にしたものと、仕様に書いていないことを決めたもの。レビューでは、ここに書いたことを仕様どおりとして扱う。

- (a) **`feedback.js` の読み込み先**：`forecast.js` と `calibration.js` を読み込む（仕様の表では `scoring.js` と `calibration.js`）。
  - 理由：時間帯の定義（`TIME_SLOTS`、`SLOT_ORDER`）を `Forecast` から取るため。
  - `scoring.js` は `calibration.js` を通して使う。
- (b) **Worker のファイル分け**：処理は `worker/handler.mjs` の `handle(request, env, now)` に置く。`worker/index.mjs` は、今の時刻を渡すだけの入口にする。
  - 理由：テストで時刻を固定できるようにするため。
- (c) **許可していないオリジンの `OPTIONS`**：`403` を返し、CORS ヘッダは付けない。
- (d) **`400` の本文**：`{"error": "<違反を ' / ' でつないだ文>", "errors": [...]}`。パネルは `error` をそのまま出す。
- (e) **写真なしの `photo_meta`**：写真を付けずに送ったときは保存しない。写真の位置・時刻は、写真とセットでだけ持つ。
- (f) **`submissions` の掃除の範囲**：日本時間の今日から3日より前（`day < 今日−3日`）の行を消す。
- (g) **`Calibration.apply(rawData, spot, cal)` を追加**：`adjust` と `score` をまとめて `{data, scores}` を返す。ランキングと週間予報の両方がこれを使う。
- (h) **「実況補正」の表示場所**：ランキングのカードと、週間予報のセルを開いた詳細の両方に出す。
- (i) **ローカル確認のポート**：8001 で配信する。8000 は持ち主が自分のサーバーを立てていることがあるため。
  - `worker/.dev.vars` の `ALLOWED_ORIGINS` には 8000 と 8001 の両方を入れる。
- (j) **補正のキャッシュ**：`GET /calibration` は `max-age=300` なので、新しい記録が補正に表れるまで最大5分かかる。ブラウザで確かめるときはキャッシュを切る。
- (k) **「行ってきた」ボタンの位置**：`resultCard` の中で、`Share.camRow(...)` の直後に同じ行でつなげる。
  - 理由：ボタンを出さないとき（`FEEDBACK_API` が空）に、カードの HTML が今と1バイトも変わらないようにするため。
- (l) **確認用の静的サーバー**：Node で書いた `static.mjs` を使う。
  - 理由：`python3 -m http.server`（3.10）は listen の待ち行列が5しかない。Chrome がスクリプトを並列に取りに行くと、接続が切られる（ERR_CONNECTION_RESET）。
- (m) **「今の main と同じ」の比較の基準**：`git merge-base HEAD origin/main` を使う。ローカルの `main` は古いことがあるため。
- (n) **テスト用 D1 の `?N`**：`worker/quota.mjs` の SQL は `?1`〜`?15` で同じ値を何度も使う。D1 はこの書き方を受け付けるが、`node:sqlite` は番号どおりに結び付けない。そこで `worker/d1-sqlite.mjs` が `?N` を `?` に書き換え、値を出てくる順に並べ直す。本番の SQL は `?N` のまま。
- (o) **ローカルで設定を変えて Worker を立てる方法**：`npx wrangler@4 dev --var 名前:値` を使う。`--var` が `[vars]` より優先されることは Cloudflare の文書で確かめた。`.dev.vars` が `[vars]` より優先されるかは文書で確かめられなかったので、`.dev.vars` は `[vars]` に無い `IP_SALT` と、`ALLOWED_ORIGINS` の上書きにだけ使い、効いたかは Task 8 の Step 4 で確かめる。

## R2 のコスト対策（追加の要件との対応）

写真の置き場（R2）の料金が膨らまないようにする要件を、この構成に合わせて取り込んだ。細かい数と手順は `docs/r2-security.md`（Task 7）に書く。この節は、要件のどれをどう満たすか、どれを変えたかの対応表。

**リスクの分類**（「何もしないと」は、上限を何も置かずに写真を受け付けた場合）

| リスク | 何もしないと | 対策後 | 主な対策（タスク） |
|---|---|---|---|
| API に大量に送られる | 高 | 低 | 1分・1日の件数の上限、全体の件数・容量の上限（4） |
| 大きな写真・本文 | 中 | 低 | `MAX_UPLOAD_SIZE`、本文を上限 + 512KB で読み切らずに打ち切る（4） |
| 同時に送って上限をすり抜ける | 中 | 低 | 判定と数え上げを D1 の1つのトランザクションで行う（4） |
| バグの暴走・やり直しの繰り返し | 中 | 低 | Worker はやり直さない。上限は Worker 側で数える（4、6） |
| LIST の呼び出し | 低 | 低 | Worker は list しない。数は `storage_usage` で持つ（4） |
| 公開 URL から読まれる | 中 | 低 | 非公開のバケット、r2.dev 無効、ドメインなしを確かめる（9） |
| 認証情報が漏れる | 高 | 高（Worker では防げない） | R2 の API トークンを作らない。漏れたときの手順 D（7、9） |
| 置き去りの写真 | 低 | 低 | `photo_orphan` のログ、`storage_usage` と R2 の Metrics の比べ合わせ（4、7、9） |

**要件との対応**（**変更** は、要件と違う形にしたもの）

| 要件 | この計画での形 |
|---|---|
| ユーザーごとの容量上限 | `USER_STORAGE_LIMIT`（200MB）。**変更**：ログインが無いので、ユーザーは端末 ID で数える |
| `MAX_UPLOAD_SIZE` | 1.5MB。変数で上げても 10MB まで。本文はさらに 512KB を超えたところで打ち切る |
| MIME の判定 | ファイルの先頭のバイト（JPEG の `FF D8 FF`）で判定し、違えば `415`。送る側の `Content-Type` は信じない |
| レート制限（1分10件・1日100件・IP ごと） | **変更**：1分5件（端末ごと・回線ごと）。1日は端末20件・回線30件・全体100件。この用途では1分10件は多すぎるため |
| `DAILY_UPLOAD_LIMIT` / `DAILY_UPLOAD_COUNT_LIMIT` | 端末ごとに1日 10MB / 20件 |
| `GLOBAL_DAILY_UPLOAD_LIMIT` / `GLOBAL_STORAGE_LIMIT` | 全体で1日 100MB / 合計 5GB。R2 の無料枠（10GB）の半分 |
| `R2_KILL_SWITCH` で `503` | **変更**：写真だけ置かず、記録は保存して `200 {"photo_skipped":"kill_switch"}`。送ってくれた評価を捨てないため。受け付けごと止めるときは `GLOBAL_DAILY_COUNT_LIMIT = "0"`（`429`）か、Worker を止める |
| 署名付き URL の安全性 | **変更**：署名付き URL は使わない。写真は Worker が受け取って、上限を通してから put する |
| 最小権限のトークン | R2 の API トークンは作らない。`wrangler login` はユーザーの端末だけで行う（9） |
| 非公開のバケット | 作った直後に r2.dev 無効・ドメインなしを確かめる（9） |
| キャッシュ | 写真を返す口が無いので、配信のキャッシュは無い。`GET /calibration` は `max-age=300` |
| ライフサイクル | **変更**：既定の「途中で止まったマルチパートを7日で消す」だけ。写真を自動で消すルールは足さない（消すと記録と `storage_usage` がずれるため）。古い写真を手で減らす手順を文書に書く（7） |
| LIST を使わない孤立ファイルの検出 | 消せなかった写真は `photo_orphan` のログに出す。`storage_usage` と R2 の Metrics を比べる（7、9） |
| リトライは3回まで・4xx はやり直さない | **変更**：やり直さない（0回）。失敗したら片付けて `500` を返し、送り直すかは使う人が決める |
| 冪等性 | 同じ端末・場所・日付・時間帯は1件で、送り直しは上書き。写真の差し替えは古い写真を消してから数を戻す |
| キーはサーバーが作る | 写真のキーは Worker が作る。記録やファイル名の値は使わない |
| dev / staging / prod の分離 | **変更**：staging は作らない。ローカルの `wrangler dev`（ローカルの D1・R2）とテストで確かめ、本番は1つ |
| 見張りとログ（個人情報なし） | 1件ごとに JSON のログ。端末 ID・IP・名前は出さない。消せなかった写真だけは、手で片付けるためにキー（`photos/<ランダムな ID>.jpg`）を出す |
| 失敗は安全側に倒す | 上限の変数が読めなければ `500` で何も保存しない。D1 が失敗したら写真を上げない |
| 新しい依存なし・大きな作り直しなし・秘密を書かない | 守る。`IP_SALT` は `wrangler secret` で入れ、どこにも書かない |

**要件のテストと、Task 4 のテストの対応**

| 要件のテスト | Task 4 のテスト |
|---|---|
| ふつうの送信 | `POST stores one record, the photo and a submission` |
| 大きすぎる写真・本文 | `photos are accepted up to 1,572,864 bytes and rejected with 413 above`、`a request body over 2 MB gets 413`、`a streamed body without Content-Length stops being read soon after the limit` |
| ユーザーごとの容量を超える | `USER_STORAGE_LIMIT skips photos once a device's stored photos reach it, on later days too` |
| 1日の容量を超える | `DAILY_UPLOAD_LIMIT skips photos past one device's bytes for the day` |
| 1日の件数を超える | `the 21st submission from one device in a day gets 429 device`、`the 31st submission from one connection in a day gets 429 ip` |
| レート制限を超える | `the 6th send from one device within a minute gets 429 device_minute until 60 s have passed`、`the 6th send from one connection within a minute gets 429 ip_minute` |
| MIME が違う | `a photo that is not a JPEG gets 415` |
| 認証が無い | **変更**：ログインは無い（誰でも送れる仕様）。代わりに `other or missing origins get 403 and nothing is stored` |
| ほかの人の場所に書く | `the photo key is made by the server, whatever the record or the file name says` |
| 同じ送信を繰り返す | `resending the same session overwrites it and keeps created_at`、`resending with a new photo replaces the file, deletes the old one and counts only the new one` |
| R2 のタイムアウト | `an upload that times out after writing leaves no object behind` |
| R2 の 500 | `when the photo upload fails, nothing is saved and its bytes are given back` |
| DB のエラー | `when the database cannot take the send, no photo is uploaded`、`when saving the record fails, the uploaded photo is removed, its bytes given back and 500 returned` |
| 非常停止 | `photos are not stored unless R2_KILL_SWITCH is false or 0, but the record is`、`R2_KILL_SWITCH false or 0, in any case and with spaces, lets photos through` |
| 全体の容量 | `GLOBAL_STORAGE_LIMIT holds when 10 devices send photos at once` |
| 全体の1日の量 | `GLOBAL_DAILY_UPLOAD_LIMIT skips photos past the day's total bytes`、`the 101st submission in a day overall gets 429 total` |
| 消したあとの使用量 | `resending with a new photo replaces the file, deletes the old one and counts only the new one`、`when the old photo cannot be deleted, the send still succeeds and the orphan is logged` |
| 同時に送る | `25 sends at once from one device store exactly the daily 20`、`GLOBAL_STORAGE_LIMIT holds when 10 devices send photos at once` |

**被害はどこまで広がるか**（既定の上限のまま。詳しくは `docs/r2-security.md`）
- **API が攻撃されたとき**：R2 は1日 put 100回・100MB、合計 5GB で止まり、無料枠の中なので R2 の請求は $0。無料プランの Workers と D1 は、上限でエラーになるだけで請求は来ない。ただし、その日はほかの人が送れなくなる。有料プランに移すと、リクエストと `GET /calibration` の読み取りが攻撃の量に比例して請求される。
- **バグで暴走したとき**：パネルが送り続けるバグなら、端末ごと・全体の上限で止まる。Worker が上限を通らずに R2 に書くバグには上限が効かない。これはテストで put の回数と数え上げを確かめて防ぐ。起きたら手順 A、止まらなければ C。
- **トークンが漏れたとき**：Worker の外なので、上限も非常停止も効かず、被害に上限が無い。R2 の API トークンを作らないことで漏れる物を減らし、漏れたら手順 D でトークンを消す。

予算アラートは守りではない。知らせるだけで何も止めず、届くのは1日ほど遅れる。

## 実行の前提

- **作業ブランチ**：`feat/feedback`。仕様のコミット 5b7aa91 の上で、`origin/main`（9399a27）から分かれている。
- **コミットしないもの**：`snapshot.html`（追跡していないファイル）。
  - `git add` には必ずファイル名を並べる。`git add -A` や `git add .` は使わない。
- **ポート**：8000 には触らない（持ち主のサーバーが動いていることがある）。確認には 8001〜8003 と 8787 を使う。
- **テスト**：リポジトリの直下で `node --test` を実行する。`worker/*.test.mjs` も対象になる。
  - 依存パッケージは入れない。
  - 始める前は 119 件。各タスクのあとの件数は、そのタスクに書いてある。
- **コミットメッセージ**：件名は英語、本文は日本語。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- **ユーザーの承認が要るもの**：
  - 初めて `npx wrangler@4` を実行する前（Task 8）
  - Cloudflare への公開（Task 9）
- **秘密の値**：`IP_SALT` と Cloudflare の認証情報は、リポジトリにも markdown にも書かない。
- **画面の確認（Task 5・6）に要るもの**：macOS、`/Applications/Google Chrome.app`、`sips`、`rsync`。
  - 確認用のファイルはリポジトリの外に置き、コミットしない。
  - Open-Meteo は続けて呼ぶと `429` を返すことがある。ブラウザでの確認は、1回ごとに2分空ける。

## ファイルの構成

| ファイル | 役割 | タスク |
|---|---|---|
| `calibration.js`（新規） | 帯・風の区分、1件ごとの誤差、`compute` / `metrics` / `adjust` / `score` / `apply` / `validate` / `summaryLabel`。サイト・Worker・テストで共用する | 1 |
| `calibration.test.js`（新規） | 上のテスト | 1 |
| `feedback.js`（新規） | パネルの初期値、`buildRecord` / `validateRecord`、`readExif`、`distanceKm` / `suggestSpot`。DOM には触らない。サイト・Worker・テストで共用する | 2 |
| `feedback.test.js`（新規） | 上のテスト | 2 |
| `forecast.js` / `forecast.test.js` | `weeklyForecast` に任意の `scorer` 引数を足す | 3 |
| `worker/schema.sql`（新規） | D1 のテーブル定義 | 4 |
| `worker/handler.mjs`（新規） | `POST /feedback` と `GET /calibration`、CORS、写真の保存と片付け、ログ | 4 |
| `worker/quota.mjs`（新規） | 上限の既定値と読み込み、写真の非常停止、D1 での判定と数え上げ（`reserve` / `release`） | 4 |
| `worker/index.mjs`（新規） | Worker の入口 | 4 |
| `worker/d1-sqlite.mjs`（新規） | テスト専用。`node:sqlite` を D1 と同じ呼び方で使う | 4 |
| `worker/worker.test.mjs`（新規） | Worker のテスト | 4 |
| `worker/wrangler.toml`（新規） | Worker 名、D1・R2 の紐づけ、`ALLOWED_ORIGINS`、`R2_KILL_SWITCH` | 4 |
| `.gitignore`（新規） | `worker/.dev.vars` と `worker/.wrangler/` | 4 |
| `app.js` | 補正の読み込みとかけ方、「実況補正」の表示（Task 5）。「行ってきた」ボタンとパネルの呼び出し（Task 6） | 5, 6 |
| `index.html` | スクリプトの追加と `?v=` の更新 | 5, 6 |
| `style.css` | `.chip.calib`（Task 5）。ボタンとパネル（Task 6） | 5, 6 |
| `feedback-panel.js`（新規） | ブラウザ専用。入力パネルの描画と操作、写真の縮小、送信 | 6 |
| `README.md` | 構成、フィードバック機能、ローカル開発、公開の手順、記録の消し方、名前の書き換え方 | 7 |
| `docs/r2-security.md`（新規） | 写真（R2）のコスト対策、上限の一覧と変え方、管理画面での設定、見張り方、数のずれの直し方、緊急時の手順、被害の範囲、残るリスク | 7 |

`scoring.js` は変更しない。

ブラウザでの読み込み順は `scoring.js` → `forecast.js` → `share.js` → `calibration.js` → `feedback.js` → `feedback-panel.js` → `app.js`。

---

### Task 1: 補正の計算とかけ方（`calibration.js`）

**Files:**
- Create: `calibration.js`
- Test: `calibration.test.js`（新規）

**Interfaces:**
- Consumes: `scoring.js`（変更しない）の `Scoring.scoreSpot(data, bearing)` と各項目の点数関数。
  - `data` は `{wave_height, wind_dir, wind_speed, swell_dir, swell_period}`。今の `Forecast.slotConditions` が返す形。
- Produces: Node では `require("./calibration.js")`、ブラウザでは `window.Calibration`。
  - **定数**
    - `WAVE_BANDS`：8つの `{label, lo, hi, center}`。番号 0〜7 が波の帯。
    - `WIND_STRENGTHS`：`{calm, light, strong}` のそれぞれに `{label, lo, hi, center}`。
    - `WIND_SIDES`：`{off: "オフ", side: "サイド", on: "オン"}`。
    - `DEFAULT_WEIGHTS`：`{wind_direction: 20, wind_speed: 10, swell_direction: 20, swell_period: 20, wave_height: 15}`。
  - **区分**
    - `waveBand(height)` → 0〜7
    - `windSide(windDir, bearing)` → `"off"` / `"side"` / `"on"`
    - `windStrength(speed)` → `"calm"` / `"light"` / `"strong"`
  - **1件ごとの誤差と配点の学習**（`compute` の中で使う。テストからも呼ぶ）
    - `waveError(height, band)` → 予報の波高から、答えた帯の中心までの対数比。帯の中なら 0、予報が 0 以下なら `null`。
    - `windError(speed, strength)` → 予報の風速から、答えた強さの中心までの差（m/s）。区分の中なら 0。
    - `fitWeights(rows)` → 学習した配点（合計は今の満点と同じ）、または `null`（今の配点のまま）。`rows` は `[{x: 5項目の点の割合, r: 総合, w: 重み}]`。
  - **補正の計算**
    - `compute(records)` → `{version: 1, n, spots: {<ポイント名>: {n, wave_factor, wind_offset, wind_side_hit}}, weights, weights_learned}`。`records` は D1 の `feedback` の行。
    - `metrics(records)` → `{n, wave_band_mae: {raw, calibrated}, wind_strength_hit: {raw, calibrated}, wind_side_hit, rating_concordance: {default, calibrated}}`。記録が1件以下なら、値はすべて `null`。
  - **補正のかけ方**
    - `adjust(data, spotName, cal)` → 新しい `data`
    - `score(data, bearing, cal)` → `Scoring.scoreSpot` と同じ形
    - `apply(rawData, spot, cal)` → `{data, scores}`。`spot` は `{name, bearing}`。
  - **確認と表示**
    - `validate(json)` → `boolean`
    - `summaryLabel(spotName, cal)` → 例：`"実況補正 7件（波×1.2・風+0.6m/s）"`。記録が無ければ `""`。

- [x] **Step 1: 失敗するテストを書く**

`calibration.test.js` を次の内容で作る。

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("./calibration.js");
const S = require("./scoring.js");

const round3 = (v) => Math.round(v * 1000) / 1000;
const W0 = { wind_direction: 20, wind_speed: 10, swell_direction: 20, swell_period: 20, wave_height: 15 };
const KEYS = Object.keys(W0);

// A D1 feedback row. Bearing 90, so the offshore wind blows from 270.
// The observed values match the forecast unless overridden.
function row(overrides = {}) {
  return {
    device_id: "dev-a", spot: "一宮", bearing: 90,
    fc_wave_height: 1.0, fc_wind_dir: 270, fc_wind_speed: 3, fc_swell_dir: 90, fc_swell_period: 11,
    rating: 3, wave_band: 3, wind_side: "off", wind_strength: "light",
    ...overrides,
  };
}

// --- bands and categories ---

test("waveBand splits at 0.3/0.5/0.8/1.1/1.5/2.0/2.5, each band [lo, hi)", () => {
  const cases = [[0, 0], [0.29, 0], [0.3, 1], [0.49, 1], [0.5, 2], [0.79, 2], [0.8, 3], [1.09, 3],
    [1.1, 4], [1.49, 4], [1.5, 5], [1.99, 5], [2.0, 6], [2.49, 6], [2.5, 7], [6, 7]];
  for (const [h, band] of cases) assert.equal(C.waveBand(h), band, `h=${h}`);
});

test("waveBand labels agree with Scoring.waveSizeLabel from 0 to 4 m", () => {
  for (let i = 0; i <= 80; i++) {
    const h = i / 20;
    assert.equal(C.WAVE_BANDS[C.waveBand(h)].label, S.waveSizeLabel(h), `h=${h}`);
  }
});

test("windSide is off up to 75°, side up to 105°, on beyond (from offshore)", () => {
  // bearing 90 -> offshore wind comes from 270
  assert.equal(C.windSide(270, 90), "off");
  assert.equal(C.windSide(345, 90), "off"); // 75
  assert.equal(C.windSide(346, 90), "side"); // 76
  assert.equal(C.windSide(15, 90), "side"); // 105
  assert.equal(C.windSide(16, 90), "on"); // 106
  assert.equal(C.windSide(90, 90), "on"); // 180
});

test("windStrength is calm up to 2, light up to 5, strong beyond", () => {
  assert.equal(C.windStrength(0), "calm");
  assert.equal(C.windStrength(2), "calm");
  assert.equal(C.windStrength(2.01), "light");
  assert.equal(C.windStrength(5), "light");
  assert.equal(C.windStrength(5.01), "strong");
});

// --- per-record errors ---

test("waveError is 0 inside the observed band and the log ratio to its center outside", () => {
  assert.equal(C.waveError(1.0, 3), 0);
  assert.equal(C.waveError(0.8, 3), 0);
  assert.equal(C.waveError(1.1, 3), Math.log(0.95 / 1.1)); // 1.1 belongs to band 4
  assert.equal(C.waveError(0.6, 3), Math.log(0.95 / 0.6));
});

test("waveError clamps to ±ln 2 and skips forecasts of 0 or below", () => {
  assert.equal(C.waveError(0.2, 7), Math.LN2);
  assert.equal(C.waveError(3.0, 0), -Math.LN2);
  assert.equal(C.waveError(0, 3), null);
  assert.equal(C.waveError(-0.1, 3), null);
});

test("windError is 0 inside the observed range and center minus forecast outside, clamped to ±4", () => {
  assert.equal(C.windError(3, "light"), 0);
  assert.equal(C.windError(2, "calm"), 0);
  assert.equal(C.windError(2, "light"), 1.5); // 2 is calm, not light
  assert.equal(C.windError(6, "light"), -2.5);
  assert.equal(C.windError(1, "strong"), 4); // 7 - 1 = 6 -> 4
  assert.equal(C.windError(9, "calm"), -4); // 1 - 9 = -8 -> -4
});

// --- per-spot aggregation (K = 3) ---

const E06 = Math.log(0.95 / 0.6); // forecast 0.6 m, observed ムネ〜カタ

test("compute pulls a single record's wave error to 1/4 (K = 3)", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 })]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 4)));
  assert.equal(cal.spots["一宮"].n, 1);
});

test("compute gives three records from one device half the error", () => {
  const cal = C.compute([1, 2, 3].map(() => row({ fc_wave_height: 0.6 })));
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 2)));
});

test("compute averages two devices with one record each over 2 + 3", () => {
  const cal = C.compute([
    row({ device_id: "a", fc_wave_height: 0.6 }),
    row({ device_id: "b", fc_wave_height: 1.0 }), // in band -> error 0
  ]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 5)));
});

test("compute caps one device's weight at 5 records per spot", () => {
  const five = C.compute(Array.from({ length: 5 }, () => row({ fc_wave_height: 0.6 })));
  const eight = C.compute(Array.from({ length: 8 }, () => row({ fc_wave_height: 0.6 })));
  assert.equal(eight.spots["一宮"].wave_factor, round3(Math.exp((5 * E06) / 8)));
  assert.equal(eight.spots["一宮"].wave_factor, five.spots["一宮"].wave_factor);
});

test("compute leaves forecasts of 0 out of the wave factor but counts them elsewhere", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 }), row({ device_id: "b", fc_wave_height: 0, wave_band: 2 })]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 4)));
  assert.equal(cal.spots["一宮"].n, 2);
});

test("compute derives wind_offset the same way and wind_side_hit as a plain rate", () => {
  const cal = C.compute([
    row({ fc_wind_speed: 6, wind_strength: "light" }), // error -2.5
    row({ device_id: "b", wind_side: "on" }), // forecast off -> miss
  ]);
  assert.equal(cal.spots["一宮"].wind_offset, round3(-2.5 / 5));
  assert.equal(cal.spots["一宮"].wind_side_hit, 0.5);
});

test("compute keeps each spot separate and returns defaults with no records", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 }), row({ spot: "志田下" })]);
  assert.deepEqual(Object.keys(cal.spots).sort(), ["一宮", "志田下"].sort());
  assert.equal(cal.spots["志田下"].wave_factor, 1);
  assert.deepEqual(C.compute([]), { version: 1, n: 0, spots: {}, weights: W0, weights_learned: false });
});

// --- weights ---

// All 32 on/off combinations of the five features: orthogonal once centered.
function factorial(ratingOf) {
  const rows = [];
  for (let m = 0; m < 32; m++) {
    const x = [0, 1, 2, 3, 4].map((i) => (m >> i) & 1);
    rows.push({ x, r: ratingOf(x), w: 1 });
  }
  return rows;
}
const dot = (x, w) => x.reduce((s, xi, i) => s + xi * w[i], 0);
const W0_LIST = KEYS.map((k) => W0[k]);

test("fitWeights returns the default weights when ratings follow the default total exactly", () => {
  const w = C.fitWeights(factorial((x) => 1 + (4 * dot(x, W0_LIST)) / 85));
  for (const k of KEYS) assert.ok(Math.abs(w[k] - W0[k]) < 1e-9, `${k}: ${w[k]}`);
});

test("fitWeights raises the weight of a component the ratings lean on", () => {
  const w = C.fitWeights(factorial((x) => 1 + (4 * (dot(x, W0_LIST) + 20 * x[4])) / 105));
  assert.ok(w.wave_height > 15, `wave_height ${w.wave_height}`);
  for (const k of KEYS.filter((k) => k !== "wave_height")) {
    assert.ok(w.wave_height / 15 > w[k] / W0[k], k);
  }
});

test("fitWeights clamps each weight to 0.5-2x before rescaling the sum to 85", () => {
  // Ratings depend on the swell period only: it hits 2x (40), the rest hit 0.5x.
  const w = C.fitWeights(factorial((x) => 1 + 4 * x[3]));
  const scale = 85 / (10 + 5 + 10 + 40 + 7.5);
  assert.deepEqual(Object.fromEntries(KEYS.map((k) => [k, round3(w[k])])), {
    wind_direction: round3(10 * scale), wind_speed: round3(5 * scale), swell_direction: round3(10 * scale),
    swell_period: round3(40 * scale), wave_height: round3(7.5 * scale),
  });
  assert.ok(Math.abs(KEYS.reduce((s, k) => s + w[k], 0) - 85) < 1e-9);
});

test("fitWeights keeps the defaults when ratings are flat, inverted, or the totals never vary", () => {
  assert.equal(C.fitWeights(factorial(() => 3)), null);
  assert.equal(C.fitWeights(factorial((x) => 5 - (4 * dot(x, W0_LIST)) / 85)), null);
  const same = Array.from({ length: 20 }, (_, j) => ({ x: [1, 1, 0, 1, 0], r: 1 + (j % 5), w: 1 }));
  assert.equal(C.fitWeights(same), null);
});

// Records spread over the five components; the observed values match the
// forecast so the spot factors stay neutral and features equal raw points.
function spreadRecords(ratingOf, device = (j) => `dev-${j}`) {
  const winds = [[270, 1], [0, 4], [90, 10]];
  const swells = [[90, 16], [150, 11], [200, 7]];
  const heights = [0.4, 1.2, 2.2];
  const out = [];
  let j = 0;
  for (const [wd, ws] of winds) for (const [sd, sp] of swells) for (const h of heights) {
    const data = { wind_dir: wd, wind_speed: ws, swell_dir: sd, swell_period: sp, wave_height: h };
    const scores = S.scoreSpot(data, 90);
    out.push(row({
      device_id: device(j), fc_wind_dir: wd, fc_wind_speed: ws, fc_swell_dir: sd, fc_swell_period: sp, fc_wave_height: h,
      wave_band: C.waveBand(h), wind_side: C.windSide(wd, 90), wind_strength: C.windStrength(ws),
      rating: ratingOf(scores),
    }));
    j += 1;
  }
  return out;
}
const byTotal = (s) => Math.min(5, Math.max(1, Math.round(1 + (4 * s.total) / 85)));

test("compute keeps the default weights below 15 records and learns from 15", () => {
  const records = spreadRecords(byTotal);
  const fourteen = C.compute(records.slice(0, 14));
  assert.equal(fourteen.weights_learned, false);
  assert.deepEqual(fourteen.weights, W0);
  const fifteen = C.compute(records.slice(0, 15));
  assert.equal(fifteen.weights_learned, true);
});

test("compute learns weights near the defaults from ratings that follow the default total", () => {
  const cal = C.compute(spreadRecords(byTotal));
  assert.equal(cal.weights_learned, true);
  for (const k of KEYS) {
    const ratio = cal.weights[k] / W0[k];
    assert.ok(ratio > 0.75 && ratio < 1.25, `${k}: ${cal.weights[k]}`);
  }
  assert.ok(Math.abs(KEYS.reduce((s, k) => s + cal.weights[k], 0) - 85) <= 0.01);
});

test("compute weights a device's records by min(1, 30 / its record count)", () => {
  const bySize = (s) => (s.wave_height >= 10 ? 5 : 1);
  const byPeriod = (s) => (s.swell_period >= 10 ? 5 : 1);
  const others = spreadRecords(byPeriod);
  const heavy = spreadRecords(bySize, () => "heavy").slice(0, 15);
  const copies = (n, device) => Array.from({ length: n }, () => heavy.map((r) => ({ ...r, device_id: device }))).flat();
  // 60 records from one device weigh 0.5 each: the same as 30 records weighing 1.
  const sixty = C.compute([...others, ...copies(4, "heavy")]);
  const thirty = C.compute([...others, ...copies(2, "heavy")]);
  // Without the cap, 60 records from two devices of 30 pull twice as hard.
  const twoDevices = C.compute([...others, ...copies(2, "heavy"), ...copies(2, "heavy-2")]);
  for (const k of KEYS) assert.ok(Math.abs(sixty.weights[k] - thirty.weights[k]) < 0.002, k);
  assert.notDeepEqual(sixty.weights, twoDevices.weights);
});

// --- adjust / score ---

const DATA = { wind_dir: 270, wind_speed: 3, swell_dir: 90, swell_period: 11, wave_height: 1.0 };
const CAL = {
  version: 1, n: 3,
  spots: { 一宮: { n: 3, wave_factor: 1.2, wind_offset: 0.6, wind_side_hit: 1 } },
  weights: W0, weights_learned: false,
};

test("adjust scales the wave height and shifts the wind speed without touching its input", () => {
  const input = { ...DATA };
  const out = C.adjust(input, "一宮", CAL);
  assert.deepEqual(out, { ...DATA, wave_height: 1.2, wind_speed: 3.6 });
  assert.deepEqual(input, DATA);
});

test("adjust passes unknown spots and a null calibration through as copies", () => {
  assert.deepEqual(C.adjust(DATA, "志田下", CAL), DATA);
  assert.deepEqual(C.adjust(DATA, "一宮", null), DATA);
  assert.notEqual(C.adjust(DATA, "一宮", null), DATA);
  assert.deepEqual(C.adjust(DATA, "constructor", CAL), DATA);
});

test("adjust never pushes the wind speed below 0", () => {
  const cal = { ...CAL, spots: { 一宮: { n: 1, wave_factor: 1, wind_offset: -4, wind_side_hit: 1 } } };
  const out = C.adjust({ ...DATA, wind_speed: 1.5 }, "一宮", cal);
  assert.equal(out.wind_speed, 0);
  assert.equal(C.score(out, 90, cal).wind_speed, 10);
});

test("score matches Scoring.scoreSpot exactly with the default weights or no calibration", () => {
  for (const wind_dir of [0, 45, 100, 200, 270, 330]) for (const wind_speed of [0, 2, 4, 7, 11, 15])
    for (const swell_dir of [90, 130, 170, 250]) for (const swell_period of [6, 9, 11, 13, 16])
      for (const wave_height of [0.2, 0.6, 1.2, 1.7, 2.4]) {
        const data = { wind_dir, wind_speed, swell_dir, swell_period, wave_height };
        const expected = S.scoreSpot(data, 90);
        assert.deepEqual(C.score(data, 90, null), expected);
        assert.deepEqual(C.score(data, 90, CAL), expected);
      }
});

test("score keeps the component points and re-weights only the total", () => {
  const weights = { wind_direction: 10, wind_speed: 10, swell_direction: 20, swell_period: 20, wave_height: 25 };
  const out = C.score(DATA, 90, { ...CAL, weights });
  const base = S.scoreSpot(DATA, 90); // 20, 8, 20, 10, 10
  assert.deepEqual({ ...out, total: 0 }, { ...base, total: 0 });
  assert.equal(out.total, Math.round(10 * 20 / 20 + 10 * 8 / 10 + 20 * 20 / 20 + 20 * 10 / 20 + 25 * 10 / 15));
});

test("apply returns the calibrated data with its score, and the plain scoreSpot cell without calibration", () => {
  const spot = { name: "一宮", bearing: 90 };
  const adjusted = { ...DATA, wave_height: 1.2, wind_speed: 3.6 };
  assert.deepEqual(C.apply(DATA, spot, CAL), { data: adjusted, scores: C.score(adjusted, 90, CAL) });
  assert.deepEqual(C.apply(DATA, spot, null), { data: DATA, scores: S.scoreSpot(DATA, 90) });
  assert.deepEqual(C.apply(DATA, { name: "志田下", bearing: 90 }, CAL), { data: DATA, scores: S.scoreSpot(DATA, 90) });
});

// --- validate ---

test("validate accepts compute's output and the documented shape", () => {
  assert.equal(C.validate(C.compute([])), true);
  assert.equal(C.validate(C.compute(spreadRecords(byTotal))), true);
  assert.equal(C.validate(CAL), true);
});

test("validate rejects a wrong version, out-of-range values, NaN and missing fields", () => {
  const bad = [
    null, "x", { ...CAL, version: 2 }, { ...CAL, spots: [] },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wave_factor: 2.01 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wave_factor: 0.49 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wind_offset: -4.01 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wind_offset: NaN } } },
    { ...CAL, spots: { 一宮: { n: 3, wave_factor: 1.2, wind_offset: 0.6 } } },
    { ...CAL, weights: { ...W0, wave_height: undefined } },
    { ...CAL, weights: { ...W0, wind_speed: 0 } },
    { ...CAL, weights: { ...W0, wave_height: 15.2 } }, // sums to 85.2
    { ...CAL, weights: undefined },
  ];
  bad.forEach((json, i) => assert.equal(C.validate(json), false, `case ${i}`));
  assert.equal(C.validate({ ...CAL, weights: { ...W0, wave_height: 15.1 } }), true); // 85.1
});

// --- metrics ---

test("metrics shows the calibrated wave bands closer than the raw forecast for a biased spot", () => {
  // Every visitor at 一宮 saw ムネ〜カタ while the forecast said 0.6 m (コシ〜ハラ).
  const records = Array.from({ length: 8 }, (_, j) => row({ device_id: `d${j}`, fc_wave_height: 0.6, wave_band: 3 }));
  const m = C.metrics(records);
  assert.equal(m.n, 8);
  assert.equal(m.wave_band_mae.raw, 1);
  assert.equal(m.wave_band_mae.calibrated, 0);
  assert.equal(m.wind_side_hit, 1);
});

test("metrics compares rating concordance for the default and calibrated scores", () => {
  const m = C.metrics(spreadRecords(byTotal));
  assert.equal(m.rating_concordance.default, 1);
  assert.ok(m.rating_concordance.calibrated > 0.9, String(m.rating_concordance.calibrated));
  assert.equal(m.wind_strength_hit.raw, 1);
});

test("metrics returns nulls for one record or none", () => {
  const empty = {
    wave_band_mae: { raw: null, calibrated: null }, wind_strength_hit: { raw: null, calibrated: null },
    wind_side_hit: null, rating_concordance: { default: null, calibrated: null },
  };
  assert.deepEqual(C.metrics([]), { n: 0, ...empty });
  assert.deepEqual(C.metrics([row()]), { n: 1, ...empty });
});

// --- summaryLabel ---

test("summaryLabel shows the record count, the wave factor and a signed wind offset", () => {
  assert.equal(C.summaryLabel("一宮", CAL), "実況補正 3件（波×1.2・風+0.6m/s）");
  const neg = { ...CAL, spots: { 一宮: { n: 7, wave_factor: 0.84, wind_offset: -1.26, wind_side_hit: 1 } } };
  assert.equal(C.summaryLabel("一宮", neg), "実況補正 7件（波×0.8・風-1.3m/s）");
});

test("summaryLabel drops the wind part inside ±0.5 m/s", () => {
  const at = (off) => ({ ...CAL, spots: { 一宮: { n: 2, wave_factor: 1.12, wind_offset: off, wind_side_hit: 1 } } });
  assert.equal(C.summaryLabel("一宮", at(0.5)), "実況補正 2件（波×1.1・風+0.5m/s）");
  assert.equal(C.summaryLabel("一宮", at(-0.5)), "実況補正 2件（波×1.1・風-0.5m/s）");
  assert.equal(C.summaryLabel("一宮", at(0.499)), "実況補正 2件（波×1.1）");
  assert.equal(C.summaryLabel("一宮", at(-0.499)), "実況補正 2件（波×1.1）");
});

test("summaryLabel is empty for spots without records and without a calibration", () => {
  assert.equal(C.summaryLabel("志田下", CAL), "");
  assert.equal(C.summaryLabel("一宮", null), "");
  assert.equal(C.summaryLabel("一宮", C.compute([])), "");
});
```

- [x] **Step 2: テストが失敗することを確かめる**

Run: `node --test calibration.test.js`
Expected: FAIL。`Error: Cannot find module './calibration.js'`

- [x] **Step 3: 実装を書く**

`calibration.js` を次の内容で作る。

```js
// Feedback-driven calibration layered on top of scoring.js, which stays
// untouched so its thresholds keep matching the Python source of truth.
// Shared by the site, the Worker and the tests.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Calibration = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  const PRIOR_K = 3;
  const DEVICE_CAP_SPOT = 5;
  const DEVICE_CAP_WEIGHTS = 30;
  const WAVE_LOG_CLAMP = Math.LN2;
  const WIND_CLAMP = 4;
  const RIDGE_LAMBDA = 5;
  const MIN_WEIGHT_RECORDS = 15;
  const WEIGHT_BOUNDS = [0.5, 2];
  const TOTAL_POINTS = 85;

  // Same cut points as Scoring.waveSizeLabel; each band is [lo, hi).
  const WAVE_BANDS = [
    { label: "フラット", lo: 0, hi: 0.3, center: 0.15 },
    { label: "ヒザ", lo: 0.3, hi: 0.5, center: 0.4 },
    { label: "コシ〜ハラ", lo: 0.5, hi: 0.8, center: 0.65 },
    { label: "ムネ〜カタ", lo: 0.8, hi: 1.1, center: 0.95 },
    { label: "カタ〜アタマ", lo: 1.1, hi: 1.5, center: 1.3 },
    { label: "アタマ〜オーバー", lo: 1.5, hi: 2.0, center: 1.75 },
    { label: "オーバーヘッド", lo: 2.0, hi: 2.5, center: 2.25 },
    { label: "ダブル+", lo: 2.5, hi: Infinity, center: 3.0 },
  ];
  // Same cut points as Scoring.windSpeedScore; each range is (lo, hi].
  const WIND_STRENGTHS = {
    calm: { label: "無風", lo: -Infinity, hi: 2, center: 1.0 },
    light: { label: "弱い", lo: 2, hi: 5, center: 3.5 },
    strong: { label: "強い", lo: 5, hi: Infinity, center: 7.0 },
  };
  const WIND_SIDES = { off: "オフ", side: "サイド", on: "オン" };

  const COMPONENTS = [
    { key: "wind_direction", max: 20 },
    { key: "wind_speed", max: 10 },
    { key: "swell_direction", max: 20 },
    { key: "swell_period", max: 20 },
    { key: "wave_height", max: 15 },
  ];
  const DEFAULT_WEIGHTS = Object.freeze(Object.fromEntries(COMPONENTS.map((c) => [c.key, c.max])));

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

  function waveBand(height) {
    for (let i = 0; i < WAVE_BANDS.length; i++) if (height < WAVE_BANDS[i].hi) return i;
    return WAVE_BANDS.length - 1;
  }

  // Groups windConditionLabel's five labels into off / side / on.
  function windSide(windDir, bearing) {
    const diff = Scoring.angleDiff(windDir, (bearing + 180) % 360);
    if (diff <= 75) return "off";
    if (diff <= 105) return "side";
    return "on";
  }

  function windStrength(speed) {
    if (speed <= 2) return "calm";
    if (speed <= 5) return "light";
    return "strong";
  }

  // Log-ratio from the forecast to the observed band's center; 0 inside the
  // band, null when there is no positive forecast to take a ratio of.
  function waveError(height, band) {
    if (!(height > 0)) return null;
    const b = WAVE_BANDS[band];
    if (height >= b.lo && height < b.hi) return 0;
    return clamp(Math.log(b.center / height), -WAVE_LOG_CLAMP, WAVE_LOG_CLAMP);
  }

  function windError(speed, strength) {
    const s = WIND_STRENGTHS[strength];
    if (speed > s.lo && speed <= s.hi) return 0;
    return clamp(s.center - speed, -WIND_CLAMP, WIND_CLAMP);
  }

  // Per-device means, each device weighted by min(n, DEVICE_CAP_SPOT), and
  // pulled toward 0 ("no correction") by PRIOR_K pseudo-records.
  function shrunkMean(samples) {
    const byDevice = new Map();
    for (const { device, e } of samples) {
      const acc = byDevice.get(device) || { sum: 0, n: 0 };
      acc.sum += e;
      acc.n += 1;
      byDevice.set(device, acc);
    }
    let num = 0;
    let den = 0;
    for (const { sum, n } of byDevice.values()) {
      const w = Math.min(n, DEVICE_CAP_SPOT);
      num += (w * sum) / n;
      den += w;
    }
    return num / (den + PRIOR_K);
  }

  function rawData(record) {
    return {
      wind_dir: record.fc_wind_dir,
      wind_speed: record.fc_wind_speed,
      swell_dir: record.fc_swell_dir,
      swell_period: record.fc_swell_period,
      wave_height: record.fc_wave_height,
    };
  }

  function spotCalibration(records) {
    const bySpot = new Map();
    for (const r of records) {
      if (!bySpot.has(r.spot)) bySpot.set(r.spot, []);
      bySpot.get(r.spot).push(r);
    }
    const spots = {};
    for (const [name, rs] of bySpot) {
      const wave = [];
      const wind = [];
      let sideHits = 0;
      for (const r of rs) {
        const we = waveError(r.fc_wave_height, r.wave_band);
        if (we !== null) wave.push({ device: r.device_id, e: we });
        wind.push({ device: r.device_id, e: windError(r.fc_wind_speed, r.wind_strength) });
        if (windSide(r.fc_wind_dir, r.bearing) === r.wind_side) sideHits += 1;
      }
      spots[name] = {
        n: rs.length,
        wave_factor: Math.exp(shrunkMean(wave)),
        wind_offset: shrunkMean(wind),
        wind_side_hit: sideHits / rs.length,
      };
    }
    return spots;
  }

  function adjust(data, spotName, cal) {
    const s = cal && own(cal.spots, spotName) ? cal.spots[spotName] : null;
    if (!s) return { ...data };
    return {
      ...data,
      wave_height: data.wave_height * s.wave_factor,
      wind_speed: Math.max(0, data.wind_speed + s.wind_offset),
    };
  }

  // Component points stay scoreSpot's; only the total is re-weighted.
  function score(data, bearing, cal) {
    const base = Scoring.scoreSpot(data, bearing);
    const weights = (cal && cal.weights) || DEFAULT_WEIGHTS;
    let total = 0;
    for (const c of COMPONENTS) total += (weights[c.key] * base[c.key]) / c.max;
    return { ...base, total: Math.round(total) };
  }

  // One forecast cell as the site shows it: { data, scores } after calibration.
  // Used by the ranking and, as weeklyForecast's scorer, by the weekly view.
  function apply(rawData, spot, cal) {
    const data = adjust(rawData, spot.name, cal);
    return { data, scores: score(data, spot.bearing, cal) };
  }

  function features(data, bearing) {
    const base = Scoring.scoreSpot(data, bearing);
    return COMPONENTS.map((c) => base[c.key] / c.max);
  }

  // Gaussian elimination with partial pivoting; A is n×n, b has length n.
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  // rows: [{ x: [5 features in COMPONENTS order, each 0..1], r: rating, w: row weight }].
  // Returns learned weights (summing to TOTAL_POINTS), or null to keep the defaults.
  function fitWeights(rows) {
    const w0 = COMPONENTS.map((c) => DEFAULT_WEIGHTS[c.key]);
    const W = rows.reduce((s, row) => s + row.w, 0);
    if (!(W > 0)) return null;
    const t = rows.map((row) => row.x.reduce((s, xi, i) => s + w0[i] * xi, 0));
    const tBar = rows.reduce((s, row, j) => s + row.w * t[j], 0) / W;
    const rBar = rows.reduce((s, row) => s + row.w * row.r, 0) / W;
    let varT = 0;
    let covTR = 0;
    rows.forEach((row, j) => {
      varT += row.w * (t[j] - tBar) ** 2;
      covTR += row.w * (t[j] - tBar) * (row.r - rBar);
    });
    if (!(varT > 1e-12)) return null;
    const gamma = covTR / varT;
    if (!(gamma > 0)) return null;

    const k = COMPONENTS.length;
    const xBar = w0.map((_, i) => rows.reduce((s, row) => s + row.w * row.x[i], 0) / W);
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, m) => (i === m ? RIDGE_LAMBDA : 0)));
    const b = w0.map((wi) => RIDGE_LAMBDA * gamma * wi);
    for (const row of rows) {
      const xc = row.x.map((xi, i) => xi - xBar[i]);
      const rc = row.r - rBar;
      for (let i = 0; i < k; i++) {
        b[i] += row.w * xc[i] * rc;
        for (let m = 0; m < k; m++) A[i][m] += row.w * xc[i] * xc[m];
      }
    }
    const theta = solve(A, b);
    const bounded = theta.map((th, i) => clamp(th / gamma, WEIGHT_BOUNDS[0] * w0[i], WEIGHT_BOUNDS[1] * w0[i]));
    const scale = TOTAL_POINTS / bounded.reduce((s, v) => s + v, 0);
    return Object.fromEntries(COMPONENTS.map((c, i) => [c.key, bounded[i] * scale]));
  }

  function learnWeights(records, spots) {
    if (records.length < MIN_WEIGHT_RECORDS) return null;
    const perDevice = new Map();
    for (const r of records) perDevice.set(r.device_id, (perDevice.get(r.device_id) || 0) + 1);
    const cal = { spots };
    const rows = records.map((r) => ({
      x: features(adjust(rawData(r), r.spot, cal), r.bearing),
      r: r.rating,
      w: Math.min(1, DEVICE_CAP_WEIGHTS / perDevice.get(r.device_id)),
    }));
    return fitWeights(rows);
  }

  function compute(records) {
    const spots = spotCalibration(records);
    const learned = learnWeights(records, spots);
    const outSpots = {};
    for (const [name, s] of Object.entries(spots)) {
      outSpots[name] = {
        n: s.n,
        wave_factor: round3(s.wave_factor),
        wind_offset: round3(s.wind_offset),
        wind_side_hit: round3(s.wind_side_hit),
      };
    }
    const weights = learned || DEFAULT_WEIGHTS;
    return {
      version: 1,
      n: records.length,
      spots: outSpots,
      weights: Object.fromEntries(COMPONENTS.map((c) => [c.key, round3(weights[c.key])])),
      weights_learned: Boolean(learned),
    };
  }

  // Share of rating-discordant pairs whose higher-rated record got the higher
  // score; tied scores count half. null when every rating is the same.
  function concordance(ratings, scores) {
    let pairs = 0;
    let agree = 0;
    for (let i = 0; i < ratings.length; i++) {
      for (let j = i + 1; j < ratings.length; j++) {
        if (ratings[i] === ratings[j]) continue;
        pairs += 1;
        const hi = ratings[i] > ratings[j] ? i : j;
        const lo = hi === i ? j : i;
        if (scores[hi] > scores[lo]) agree += 1;
        else if (scores[hi] === scores[lo]) agree += 0.5;
      }
    }
    return pairs ? agree / pairs : null;
  }

  // Leave-one-out: each record is predicted by a calibration computed from
  // all the other records. O(n²) compute calls — fine for a few hundred.
  function metrics(records) {
    const n = records.length;
    const out = {
      n,
      wave_band_mae: { raw: null, calibrated: null },
      wind_strength_hit: { raw: null, calibrated: null },
      wind_side_hit: null,
      rating_concordance: { default: null, calibrated: null },
    };
    if (n < 2) return out;
    let maeRaw = 0;
    let maeCal = 0;
    let windRaw = 0;
    let windCal = 0;
    let side = 0;
    const ratings = [];
    const defaultScores = [];
    const calScores = [];
    records.forEach((r, j) => {
      const cal = compute(records.filter((_, i) => i !== j));
      const raw = rawData(r);
      const adj = adjust(raw, r.spot, cal);
      maeRaw += Math.abs(waveBand(raw.wave_height) - r.wave_band);
      maeCal += Math.abs(waveBand(adj.wave_height) - r.wave_band);
      if (windStrength(raw.wind_speed) === r.wind_strength) windRaw += 1;
      if (windStrength(adj.wind_speed) === r.wind_strength) windCal += 1;
      if (windSide(raw.wind_dir, r.bearing) === r.wind_side) side += 1;
      ratings.push(r.rating);
      defaultScores.push(Scoring.scoreSpot(raw, r.bearing).total);
      calScores.push(score(adj, r.bearing, cal).total);
    });
    const def = concordance(ratings, defaultScores);
    const calc = concordance(ratings, calScores);
    out.wave_band_mae = { raw: round3(maeRaw / n), calibrated: round3(maeCal / n) };
    out.wind_strength_hit = { raw: round3(windRaw / n), calibrated: round3(windCal / n) };
    out.wind_side_hit = round3(side / n);
    out.rating_concordance = {
      default: def === null ? null : round3(def),
      calibrated: calc === null ? null : round3(calc),
    };
    return out;
  }

  function validate(json) {
    if (!json || typeof json !== "object" || json.version !== 1) return false;
    if (!json.spots || typeof json.spots !== "object" || Array.isArray(json.spots)) return false;
    for (const s of Object.values(json.spots)) {
      if (!s || typeof s !== "object") return false;
      if (![s.n, s.wave_factor, s.wind_offset, s.wind_side_hit].every(Number.isFinite)) return false;
      if (s.wave_factor < 0.5 || s.wave_factor > 2) return false;
      if (s.wind_offset < -4 || s.wind_offset > 4) return false;
    }
    const w = json.weights;
    if (!w || typeof w !== "object") return false;
    let sum = 0;
    for (const c of COMPONENTS) {
      const v = w[c.key];
      if (!Number.isFinite(v) || v <= 0) return false;
      sum += v;
    }
    return Math.abs(sum - TOTAL_POINTS) <= 0.1;
  }

  // "実況補正 7件（波×1.2・風+0.6m/s）"; empty when the spot has no records.
  function summaryLabel(spotName, cal) {
    const s = cal && own(cal.spots, spotName) ? cal.spots[spotName] : null;
    if (!s || !(s.n >= 1)) return "";
    const parts = [`波×${s.wave_factor.toFixed(1)}`];
    if (Math.abs(s.wind_offset) >= 0.5) {
      parts.push(`風${s.wind_offset > 0 ? "+" : "-"}${Math.abs(s.wind_offset).toFixed(1)}m/s`);
    }
    return `実況補正 ${s.n}件（${parts.join("・")}）`;
  }

  return {
    WAVE_BANDS, WIND_STRENGTHS, WIND_SIDES, DEFAULT_WEIGHTS,
    waveBand, windSide, windStrength, waveError, windError,
    compute, fitWeights, metrics, adjust, score, apply, validate, summaryLabel,
  };
});
```

- [x] **Step 4: テストが通ることを確かめる**

Run: `node --test calibration.test.js`
Expected: `ℹ tests 35`、`ℹ pass 35`、`ℹ fail 0`

- [x] **Step 5: 全体のテストを流す**

Run: `node --test`
Expected: `ℹ tests 154`、`ℹ fail 0`

- [x] **Step 6: コミットする**

```bash
git add calibration.js calibration.test.js
git commit -F - <<'EOF'
feat: add calibration from session feedback

実況フィードバックの記録から、ポイントごとの波サイズの倍率・風速のずれと、
ランキングの配点を計算する calibration.js を追加した。scoring.js は変えず、
上乗せでかける（adjust / score / apply）。validate で形を確かめ、
metrics で leave-one-out の効果を測る。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: 記録の組み立て・入力チェック・EXIF（`feedback.js`）

**Files:**
- Create: `feedback.js`
- Test: `feedback.test.js`（新規）

**Interfaces:**
- Consumes:
  - `forecast.js` の `Forecast.TIME_SLOTS` と `Forecast.SLOT_ORDER`（今のまま）
  - Task 1 の `Calibration.waveBand` / `windSide` / `windStrength`
- Produces: Node では `require("./feedback.js")`、ブラウザでは `window.Feedback`。すべて日本時間で動く。`now` は `Date`。
  - **日付と時間帯**
    - `jstNow(now)` → `{date: "YYYY-MM-DD", minutes}`
    - `shiftDay(date, days)` → `"YYYY-MM-DD"`
    - `dateRange(now)` → `{min, max}`（30日前〜今日）
    - `slotStarted(date, slot, now)` → `boolean`
    - `defaultSession(card, now)` → `{date, slot}`。`card` は `{date, slot}`。
    - `slotForTime(takenAt)` → `"morning"` / `"afternoon"` / `"evening"`
    - `sessionFromPhoto(takenAt, now)` → `{date, slot}` または `null`
  - **記録**
    - `initialObserved(data, bearing)` → `{wave_band, wind_side, wind_strength}`（`rating` は含めない。入力パネルは `Object.assign` で重ねるので、先に選ばれた総合を消さない）
    - `buildRecord({deviceId, name, spot, date, slot, rawData, observed, photoMeta})` → 仕様の `POST /feedback` の `record` の形
    - `validateRecord(rec, now)` → 日本語のエラー文の配列。空なら正しい。
  - **写真と位置**
    - `readExif(arrayBuffer)` → `{lat, lon, taken_at}`（それぞれ `null` のこともある）または `null`。例外は投げない。
    - `distanceKm(a, b)`：`a` と `b` は `{lat, lon}`。
    - `suggestSpot(meta, current, spots)` → `{spot, km}` または `null`

- [x] **Step 1: 失敗するテストを書く**

`feedback.test.js` を次の内容で作る。EXIF のテストは、テストの中でバイト列から JPEG を組み立てる（リトルエンディアンとビッグエンディアンの両方）。

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Feedback = require("./feedback.js");

// Japan time → the UTC instant the Worker and browsers see.
const jst = (s) => new Date(Date.parse(`${s}:00+09:00`));
const NOW = jst("2026-09-23T13:00"); // Wednesday afternoon, JST
const DEVICE = "2f1c6a3e-9b7d-4c21-8e5f-0a1b2c3d4e5f";

function validRecord(overrides = {}) {
  return {
    device_id: DEVICE,
    name: "",
    spot: "一宮",
    date: "2026-09-23",
    slot: "morning",
    bearing: 100,
    forecast: { wave_height: 0.9, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5 },
    observed: { rating: 4, wave_band: 3, wind_side: "off", wind_strength: "light" },
    photo_meta: { lat: 35.34, lon: 140.39, taken_at: "2026-09-23T07:42" },
    ...overrides,
  };
}
const withForecast = (patch) => validRecord({ forecast: { ...validRecord().forecast, ...patch } });
const withObserved = (patch) => validRecord({ observed: { ...validRecord().observed, ...patch } });
const withPhoto = (patch) => validRecord({ photo_meta: { ...validRecord().photo_meta, ...patch } });
const fields = (errors) => errors.map((e) => e.split(":")[0]);

// --- JST helpers ---

test("jstNow converts a UTC instant to the Japan date and minutes", () => {
  assert.deepEqual(Feedback.jstNow(new Date("2026-09-22T15:00:00Z")), { date: "2026-09-23", minutes: 0 });
  assert.deepEqual(Feedback.jstNow(new Date("2026-09-22T14:59:00Z")), { date: "2026-09-22", minutes: 23 * 60 + 59 });
});

test("dateRange spans 30 days before today through today", () => {
  assert.deepEqual(Feedback.dateRange(NOW), { min: "2026-08-24", max: "2026-09-23" });
});

// --- defaultSession ---

test("defaultSession keeps the card's slot at the exact start minute", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, jst("2026-09-23T07:00")), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "afternoon" }, jst("2026-09-23T12:00")), { date: "2026-09-23", slot: "afternoon" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "evening" }, jst("2026-09-23T16:00")), { date: "2026-09-23", slot: "evening" });
});

test("defaultSession falls back one minute before a slot starts", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "afternoon" }, jst("2026-09-23T11:59")), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "evening" }, jst("2026-09-23T15:59")), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession before 7:00 is the previous evening", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, jst("2026-09-23T06:59")), { date: "2026-09-22", slot: "evening" });
});

test("defaultSession keeps a past date's slot and replaces a future date", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-20", slot: "evening" }, NOW), { date: "2026-09-20", slot: "evening" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-25", slot: "morning" }, NOW), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession replaces a date older than 30 days", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-08-24", slot: "morning" }, NOW), { date: "2026-08-24", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-08-23", slot: "morning" }, NOW), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession uses Japan time on a UTC clock across midnight", () => {
  // 2026-09-22T22:30Z is 07:30 on the 23rd in Japan: today's morning has begun.
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, new Date("2026-09-22T22:30:00Z")), { date: "2026-09-23", slot: "morning" });
  // 2026-09-22T15:30Z is 00:30 on the 23rd: before 7:00, so the evening of the 22nd.
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, new Date("2026-09-22T15:30:00Z")), { date: "2026-09-22", slot: "evening" });
});

// --- slotForTime / sessionFromPhoto ---

test("slotForTime picks the slot containing the time, ends included", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T07:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T10:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T13:30"), "afternoon");
  assert.equal(Feedback.slotForTime("2026-09-23T19:00"), "evening");
});

test("slotForTime picks the nearest slot between and outside ranges", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T10:59"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T11:01"), "afternoon");
  assert.equal(Feedback.slotForTime("2026-09-23T05:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T22:00"), "evening");
});

test("slotForTime breaks ties toward the earlier slot", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T11:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T15:30"), "afternoon");
});

test("sessionFromPhoto returns the photo's date and slot when selectable", () => {
  assert.deepEqual(Feedback.sessionFromPhoto("2026-09-23T07:42", NOW), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.sessionFromPhoto("2026-09-10T17:10", NOW), { date: "2026-09-10", slot: "evening" });
});

test("sessionFromPhoto rejects out-of-range dates, unstarted slots and missing times", () => {
  assert.equal(Feedback.sessionFromPhoto("2026-08-23T08:00", NOW), null);
  assert.equal(Feedback.sessionFromPhoto("2026-09-24T08:00", NOW), null);
  // 15:50 is nearest the evening slot, which has not begun at 13:00.
  assert.equal(Feedback.sessionFromPhoto("2026-09-23T15:50", NOW), null);
  assert.equal(Feedback.sessionFromPhoto(null, NOW), null);
});

// --- initialObserved / buildRecord ---

test("initialObserved derives band, side and strength from the shown forecast", () => {
  assert.deepEqual(
    Feedback.initialObserved({ wave_height: 1.2, wind_dir: 270, wind_speed: 3.6, swell_dir: 90, swell_period: 11 }, 90),
    { wave_band: 4, wind_side: "off", wind_strength: "light" },
  );
  assert.deepEqual(
    Feedback.initialObserved({ wave_height: 0.3, wind_dir: 90, wind_speed: 2, swell_dir: 90, swell_period: 11 }, 90),
    { wave_band: 1, wind_side: "on", wind_strength: "calm" },
  );
});

test("buildRecord stores the raw forecast, the trimmed name and a null photo_meta", () => {
  const rec = Feedback.buildRecord({
    deviceId: DEVICE,
    name: "  たろう ",
    spot: { name: "一宮", bearing: 100, lat: 35.37, lon: 140.39 },
    date: "2026-09-23",
    slot: "morning",
    rawData: { wave_height: 0.9, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5, extra: 1 },
    observed: { rating: 4, wave_band: 3, wind_side: "off", wind_strength: "light" },
  });
  assert.deepEqual(rec, { ...validRecord(), name: "たろう", photo_meta: null });
  assert.deepEqual(Feedback.validateRecord(rec, NOW), []);
});

// --- validateRecord ---

function assertValid(rec) {
  assert.deepEqual(Feedback.validateRecord(rec, NOW), []);
}
function assertInvalid(rec, field) {
  assert.deepEqual(fields(Feedback.validateRecord(rec, NOW)), [field]);
}

test("validateRecord accepts the spec example and a null photo_meta", () => {
  assertValid(validRecord());
  assertValid(validRecord({ photo_meta: null }));
  assertValid(withPhoto({ lat: null, lon: null, taken_at: null }));
});

test("validateRecord rejects a non-object record", () => {
  assert.deepEqual(fields(Feedback.validateRecord(null, NOW)), ["record"]);
  assert.deepEqual(fields(Feedback.validateRecord([], NOW)), ["record"]);
  assert.deepEqual(fields(Feedback.validateRecord("x", NOW)), ["record"]);
});

test("validateRecord checks device_id is a UUID v4", () => {
  assertInvalid(validRecord({ device_id: "not-a-uuid" }), "device_id");
  assertInvalid(validRecord({ device_id: "2f1c6a3e-9b7d-1c21-8e5f-0a1b2c3d4e5f" }), "device_id"); // version 1
  assertInvalid(validRecord({ device_id: 123 }), "device_id");
});

test("validateRecord limits name to 20 characters after trimming, without control characters", () => {
  assertValid(validRecord({ name: "あ".repeat(20) }));
  assertValid(validRecord({ name: `  ${"a".repeat(20)}  ` }));
  assertValid(validRecord({ name: "🏄".repeat(20) }));
  assertInvalid(validRecord({ name: "あ".repeat(21) }), "name");
  assertInvalid(validRecord({ name: "a\tb" }), "name");
  assertInvalid(validRecord({ name: null }), "name");
});

test("validateRecord limits spot to 1-40 characters", () => {
  assertValid(validRecord({ spot: "あ".repeat(40) }));
  assertInvalid(validRecord({ spot: "" }), "spot");
  assertInvalid(validRecord({ spot: "あ".repeat(41) }), "spot");
});

test("validateRecord accepts dates from 30 days ago through today", () => {
  assertValid(validRecord({ date: "2026-08-24" }));
  assertInvalid(validRecord({ date: "2026-08-23" }), "date");
  assertInvalid(validRecord({ date: "2026-09-24" }), "date");
  assertInvalid(validRecord({ date: "2026-02-30" }), "date");
  assertInvalid(validRecord({ date: "2026-9-23" }), "date");
});

test("validateRecord rejects unknown slots and today's slots that have not begun", () => {
  assertValid(validRecord({ slot: "afternoon" }));
  assertValid(validRecord({ date: "2026-09-22", slot: "evening" }));
  assertInvalid(validRecord({ slot: "evening" }), "slot");
  assertInvalid(validRecord({ slot: "night" }), "slot");
});

test("validateRecord checks numeric ranges at both edges", () => {
  for (const bearing of [0, 360]) assertValid(validRecord({ bearing }));
  for (const bearing of [-0.1, 360.1]) assertInvalid(validRecord({ bearing }), "bearing");
  const ranges = { wave_height: [0, 20], wind_dir: [0, 360], wind_speed: [0, 60], swell_dir: [0, 360], swell_period: [0, 30] };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    assertValid(withForecast({ [key]: lo }));
    assertValid(withForecast({ [key]: hi }));
    assertInvalid(withForecast({ [key]: lo - 0.01 }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: hi + 0.01 }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: NaN }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: "1" }), `forecast.${key}`);
  }
  assertInvalid(validRecord({ forecast: null }), "forecast");
});

test("validateRecord checks observed values", () => {
  for (const rating of [1, 5]) assertValid(withObserved({ rating }));
  for (const rating of [0, 6, 3.5, "4"]) assertInvalid(withObserved({ rating }), "observed.rating");
  for (const wave_band of [0, 7]) assertValid(withObserved({ wave_band }));
  for (const wave_band of [-1, 8, 2.5]) assertInvalid(withObserved({ wave_band }), "observed.wave_band");
  for (const wind_side of ["off", "side", "on"]) assertValid(withObserved({ wind_side }));
  for (const wind_side of ["offshore", "constructor", null]) assertInvalid(withObserved({ wind_side }), "observed.wind_side");
  for (const wind_strength of ["calm", "light", "strong"]) assertValid(withObserved({ wind_strength }));
  for (const wind_strength of ["breeze", "toString"]) assertInvalid(withObserved({ wind_strength }), "observed.wind_strength");
});

test("validateRecord checks photo_meta ranges and time format", () => {
  assertValid(withPhoto({ lat: -90, lon: 180 }));
  assertInvalid(withPhoto({ lat: 90.01 }), "photo_meta.lat");
  assertInvalid(withPhoto({ lon: -180.01 }), "photo_meta.lon");
  assertInvalid(withPhoto({ taken_at: "2026-09-23 07:42" }), "photo_meta.taken_at");
  assertInvalid(validRecord({ photo_meta: "x" }), "photo_meta");
});

test("validateRecord reports every problem at once", () => {
  const errors = Feedback.validateRecord(validRecord({ spot: "", slot: "night", observed: { rating: 0, wave_band: 3, wind_side: "off", wind_strength: "light" } }), NOW);
  assert.deepEqual(fields(errors), ["spot", "slot", "observed.rating"]);
  assert.ok(errors.every((e) => /: \S/.test(e)));
});

// --- readExif ---

// Builds a JPEG with an APP0 (JFIF) segment, then an EXIF APP1 in the given
// byte order holding DateTimeOriginal and/or GPS, then start-of-scan.
function buildJpeg({ le = true, takenAt = null, gps = null } = {}) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const entry = (tag, type, count, value) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  const ascii = (s) => Array.from(s + "\0", (c) => c.charCodeAt(0));
  const inline = (s) => [...ascii(s), 0, 0, 0, 0].slice(0, 4);
  const rationals = (dms) => dms.flatMap((v) => [...u32(Math.round(v * 100)), ...u32(100)]);

  let tiff = [];
  if (takenAt || gps) {
    const count0 = (takenAt ? 1 : 0) + (gps ? 1 : 0);
    let cursor = 8 + 2 + 12 * count0 + 4;
    const exifAt = cursor;
    if (takenAt) cursor += 2 + 12 + 4 + 20;
    const gpsAt = cursor;
    tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(count0)];
    if (takenAt) tiff.push(...entry(0x8769, 4, 1, u32(exifAt)));
    if (gps) tiff.push(...entry(0x8825, 4, 1, u32(gpsAt)));
    tiff.push(...u32(0));
    if (takenAt) tiff.push(...u16(1), ...entry(0x9003, 2, 20, u32(exifAt + 18)), ...u32(0), ...ascii(takenAt));
    if (gps) {
      tiff.push(
        ...u16(4),
        ...entry(1, 2, 2, inline(gps.latRef)),
        ...entry(2, 5, 3, u32(gpsAt + 54)),
        ...entry(3, 2, 2, inline(gps.lonRef)),
        ...entry(4, 5, 3, u32(gpsAt + 78)),
        ...u32(0),
        ...rationals(gps.lat),
        ...rationals(gps.lon),
      );
    }
  }
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 = tiff.length ? [0xff, 0xe1, (tiff.length + 8) >> 8, (tiff.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff] : [];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]).buffer;
}
const ICHINOMIYA = { latRef: "N", lat: [35, 20, 24], lonRef: "E", lon: [140, 23, 24] }; // 35.34, 140.39

test("readExif reads GPS and capture time in little-endian order", () => {
  const meta = Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, "2026-09-23T07:42");
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon - 140.39) < 1e-9);
});

test("readExif reads big-endian (Motorola) EXIF the same way", () => {
  const meta = Feedback.readExif(buildJpeg({ le: false, takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, "2026-09-23T07:42");
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon - 140.39) < 1e-9);
});

test("readExif returns null lat/lon when only the capture time exists", () => {
  assert.deepEqual(Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 16:05:00" })), { lat: null, lon: null, taken_at: "2026-09-23T16:05" });
});

test("readExif returns a null time when only GPS exists", () => {
  const meta = Feedback.readExif(buildJpeg({ gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, null);
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
});

test("readExif makes south and west negative", () => {
  const meta = Feedback.readExif(buildJpeg({ gps: { ...ICHINOMIYA, latRef: "S", lonRef: "W" } }));
  assert.ok(Math.abs(meta.lat + 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon + 140.39) < 1e-9);
});

test("readExif returns null for a JPEG without EXIF", () => {
  assert.equal(Feedback.readExif(buildJpeg()), null);
});

test("readExif returns null, without throwing, for truncated and non-JPEG input", () => {
  const full = buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA });
  for (const cut of [1, 3, 30, 60, full.byteLength - 60]) {
    assert.equal(Feedback.readExif(full.slice(0, cut)), null, `cut at ${cut}`);
  }
  assert.equal(Feedback.readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer), null);
  assert.equal(Feedback.readExif(new ArrayBuffer(0)), null);
});

// --- distanceKm / suggestSpot ---

const KM = 180 / (Math.PI * 6371); // degrees of latitude per km
const A = { name: "A", lat: 35, lon: 140 };
const B = { name: "B", lat: 35 + 1.5 * KM, lon: 140 };
const FAR = { name: "FAR", lat: 36, lon: 141 };

test("distanceKm measures along a meridian in km", () => {
  assert.ok(Math.abs(Feedback.distanceKm(A, B) - 1.5) < 1e-9);
  assert.equal(Feedback.distanceKm(A, A), 0);
});

test("suggestSpot suggests the nearest spot once the chosen one is over 1.0 km away", () => {
  const photo = { lat: 35 + 1.01 * KM, lon: 140, taken_at: null };
  const s = Feedback.suggestSpot(photo, A, [A, B, FAR]);
  assert.equal(s.spot, B);
  assert.ok(Math.abs(s.km - 0.49) < 1e-9);
});

test("suggestSpot stays quiet within 1.0 km of the chosen spot", () => {
  assert.equal(Feedback.suggestSpot({ lat: 35 + 0.99 * KM, lon: 140 }, A, [A, B, FAR]), null);
});

test("suggestSpot stays quiet when the chosen spot is the nearest", () => {
  assert.equal(Feedback.suggestSpot({ lat: 35 - 3 * KM, lon: 140 }, A, [A, B, FAR]), null);
});

test("suggestSpot stays quiet without a photo location", () => {
  assert.equal(Feedback.suggestSpot(null, A, [A, B]), null);
  assert.equal(Feedback.suggestSpot({ lat: null, lon: null, taken_at: "2026-09-23T07:00" }, A, [A, B]), null);
});
```

- [x] **Step 2: テストが失敗することを確かめる**

Run: `node --test feedback.test.js`
Expected: FAIL。`Error: Cannot find module './feedback.js'`

- [x] **Step 3: 実装を書く**

`feedback.js` を次の内容で作る。

```js
// Feedback records: panel defaults, validation (shared by the site and the
// Worker), and photo EXIF reading. No DOM access, so it runs under node --test.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./forecast.js"), require("./calibration.js"));
  } else {
    root.Feedback = factory(root.Forecast, root.Calibration);
  }
})(typeof self !== "undefined" ? self : this, function (Forecast, Calibration) {
  const { TIME_SLOTS, SLOT_ORDER } = Forecast;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // Japan has no daylight saving time
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_AGE_DAYS = 30;
  const NAME_MAX = 20;
  const SPOT_MAX = 40;
  const SUGGEST_KM = 1.0;

  const pad = (n) => String(n).padStart(2, "0");

  // Date and minutes-since-midnight in Japan time, whatever the host's zone.
  function jstNow(now) {
    const d = new Date(now.getTime() + JST_OFFSET_MS);
    return {
      date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    };
  }

  function shiftDay(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  }

  // Selectable dates: 30 days ago through today, Japan time.
  function dateRange(now) {
    const today = jstNow(now).date;
    return { min: shiftDay(today, -MAX_AGE_DAYS), max: today };
  }

  function slotStartMinutes(slot) {
    return TIME_SLOTS[slot][0] * 60;
  }

  // True when the slot on that date has begun (every slot of a past date has).
  function slotStarted(date, slot, now) {
    const { date: today, minutes } = jstNow(now);
    if (date < today) return true;
    if (date > today) return false;
    return minutes >= slotStartMinutes(slot);
  }

  function latestStarted(now) {
    const { date: today, minutes } = jstNow(now);
    let slot = null;
    for (const s of SLOT_ORDER) if (minutes >= slotStartMinutes(s)) slot = s;
    return slot ? { date: today, slot } : { date: shiftDay(today, -1), slot: SLOT_ORDER[SLOT_ORDER.length - 1] };
  }

  // The card's date and slot when they have begun and are in range;
  // otherwise the latest slot that has begun (before 7:00, yesterday evening).
  function defaultSession(card, now) {
    const { min, max } = dateRange(now);
    if (card.date >= min && card.date <= max && slotStarted(card.date, card.slot, now)) {
      return { date: card.date, slot: card.slot };
    }
    return latestStarted(now);
  }

  // Nearest slot to "YYYY-MM-DDTHH:MM"; 0 inside a slot, earlier slot on ties.
  function slotForTime(takenAt) {
    const m = parseInt(takenAt.slice(11, 13), 10) * 60 + parseInt(takenAt.slice(14, 16), 10);
    let best = null;
    let bestDist = Infinity;
    for (const slot of SLOT_ORDER) {
      const [startH, endH] = TIME_SLOTS[slot];
      const dist = m < startH * 60 ? startH * 60 - m : m > endH * 60 ? m - endH * 60 : 0;
      if (dist < bestDist) {
        best = slot;
        bestDist = dist;
      }
    }
    return best;
  }

  // Session suggested by a photo's capture time, or null when it falls
  // outside the selectable dates or on a slot of today that has not begun.
  function sessionFromPhoto(takenAt, now) {
    if (!takenAt) return null;
    const date = takenAt.slice(0, 10);
    const slot = slotForTime(takenAt);
    const { min, max } = dateRange(now);
    if (date < min || date > max || !slotStarted(date, slot, now)) return null;
    return { date, slot };
  }

  // Panel defaults from the forecast shown on the card (already calibrated).
  function initialObserved(data, bearing) {
    return {
      wave_band: Calibration.waveBand(data.wave_height),
      wind_side: Calibration.windSide(data.wind_dir, bearing),
      wind_strength: Calibration.windStrength(data.wind_speed),
    };
  }

  // rawData is the forecast before calibration: records must never learn
  // from their own corrections.
  function buildRecord({ deviceId, name, spot, date, slot, rawData, observed, photoMeta }) {
    return {
      device_id: deviceId,
      name: (name || "").trim(),
      spot: spot.name,
      date,
      slot,
      bearing: spot.bearing,
      forecast: {
        wave_height: rawData.wave_height,
        wind_dir: rawData.wind_dir,
        wind_speed: rawData.wind_speed,
        swell_dir: rawData.swell_dir,
        swell_period: rawData.swell_period,
      },
      observed: {
        rating: observed.rating,
        wave_band: observed.wave_band,
        wind_side: observed.wind_side,
        wind_strength: observed.wind_strength,
      },
      photo_meta: photoMeta || null,
    };
  }

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const charCount = (s) => Array.from(s).length;

  function realDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
  }

  // Returns a list of "field: problem" messages in Japanese; empty when valid.
  function validateRecord(rec, now) {
    if (!isObject(rec)) return ["record: 形が正しくありません"];
    const errors = [];
    const fail = (field, msg) => errors.push(`${field}: ${msg}`);

    if (typeof rec.device_id !== "string" || !UUID_V4.test(rec.device_id)) fail("device_id", "UUID v4 ではありません");
    if (typeof rec.name !== "string") fail("name", "文字列ではありません");
    else if (charCount(rec.name.trim()) > NAME_MAX) fail("name", `${NAME_MAX}文字までです`);
    else if (CONTROL.test(rec.name)) fail("name", "使えない文字が含まれています");
    if (typeof rec.spot !== "string" || charCount(rec.spot) < 1 || charCount(rec.spot) > SPOT_MAX) {
      fail("spot", `1〜${SPOT_MAX}文字で指定してください`);
    }

    const { min, max } = dateRange(now);
    const dateOk = realDate(rec.date);
    if (!dateOk) fail("date", "日付が正しくありません");
    else if (rec.date < min || rec.date > max) fail("date", "今日から30日前までの日付にしてください");
    if (!SLOT_ORDER.includes(rec.slot)) fail("slot", "morning / afternoon / evening のどれかにしてください");
    else if (dateOk && rec.date === max && !slotStarted(rec.date, rec.slot, now)) fail("slot", "まだ始まっていない時間帯です");

    if (!inRange(rec.bearing, 0, 360)) fail("bearing", "0〜360 にしてください");
    const fc = rec.forecast;
    if (!isObject(fc)) fail("forecast", "形が正しくありません");
    else {
      if (!inRange(fc.wave_height, 0, 20)) fail("forecast.wave_height", "0〜20 にしてください");
      if (!inRange(fc.wind_dir, 0, 360)) fail("forecast.wind_dir", "0〜360 にしてください");
      if (!inRange(fc.wind_speed, 0, 60)) fail("forecast.wind_speed", "0〜60 にしてください");
      if (!inRange(fc.swell_dir, 0, 360)) fail("forecast.swell_dir", "0〜360 にしてください");
      if (!inRange(fc.swell_period, 0, 30)) fail("forecast.swell_period", "0〜30 にしてください");
    }
    const ob = rec.observed;
    if (!isObject(ob)) fail("observed", "形が正しくありません");
    else {
      if (!isInt(ob.rating, 1, 5)) fail("observed.rating", "1〜5 の整数にしてください");
      if (!isInt(ob.wave_band, 0, Calibration.WAVE_BANDS.length - 1)) fail("observed.wave_band", "0〜7 の整数にしてください");
      if (!Object.prototype.hasOwnProperty.call(Calibration.WIND_SIDES, ob.wind_side)) fail("observed.wind_side", "off / side / on のどれかにしてください");
      if (!Object.prototype.hasOwnProperty.call(Calibration.WIND_STRENGTHS, ob.wind_strength)) fail("observed.wind_strength", "calm / light / strong のどれかにしてください");
    }
    const pm = rec.photo_meta;
    if (pm != null) {
      if (!isObject(pm)) fail("photo_meta", "形が正しくありません");
      else {
        if (pm.lat != null && !inRange(pm.lat, -90, 90)) fail("photo_meta.lat", "−90〜90 にしてください");
        if (pm.lon != null && !inRange(pm.lon, -180, 180)) fail("photo_meta.lon", "−180〜180 にしてください");
        if (pm.taken_at != null && (typeof pm.taken_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(pm.taken_at))) {
          fail("photo_meta.taken_at", "YYYY-MM-DDTHH:MM にしてください");
        }
      }
    }
    return errors;
  }

  // --- EXIF (JPEG only) ---

  // Returns { lat, lon, taken_at } (each possibly null), or null when the
  // file is not a JPEG, has no usable EXIF, or is cut short. Never throws.
  function readExif(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.getUint16(0) !== 0xffd8) return null;
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        if (view.getUint8(offset) !== 0xff) return null;
        const marker = view.getUint8(offset + 1);
        if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
        const size = view.getUint16(offset + 2);
        if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
          return readTiff(new DataView(buffer, offset + 10, size - 8));
        }
        offset += 2 + size;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function readTiff(tiff) {
    const order = tiff.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    const u16 = (o) => tiff.getUint16(o, le);
    const u32 = (o) => tiff.getUint32(o, le);
    if (u16(2) !== 42) return null;

    function entries(ifdOffset) {
      const out = new Map();
      const count = u16(ifdOffset);
      for (let i = 0; i < count; i++) {
        const e = ifdOffset + 2 + i * 12;
        out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
      }
      return out;
    }
    const valueOffset = (entry, bytes) => (entry.count * bytes <= 4 ? entry.at : u32(entry.at));
    function ascii(entry) {
      const start = valueOffset(entry, 1);
      let s = "";
      for (let i = 0; i < entry.count; i++) {
        const c = tiff.getUint8(start + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    function degrees(entry) {
      const start = u32(entry.at); // 3 rationals never fit inline
      let deg = 0;
      for (let i = 0; i < 3; i++) deg += u32(start + i * 8) / u32(start + i * 8 + 4) / 60 ** i;
      return deg;
    }

    const ifd0 = entries(u32(4));
    let takenAt = null;
    if (ifd0.has(0x8769)) {
      const exif = entries(u32(ifd0.get(0x8769).at));
      if (exif.has(0x9003)) {
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(ascii(exif.get(0x9003)));
        if (m) takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
      }
    }
    let lat = null;
    let lon = null;
    if (ifd0.has(0x8825)) {
      const gps = entries(u32(ifd0.get(0x8825).at));
      if ([1, 2, 3, 4].every((tag) => gps.has(tag))) {
        const la = degrees(gps.get(2)) * (ascii(gps.get(1)) === "S" ? -1 : 1);
        const lo = degrees(gps.get(4)) * (ascii(gps.get(3)) === "W" ? -1 : 1);
        if (Number.isFinite(la) && Number.isFinite(lo)) {
          lat = la;
          lon = lo;
        }
      }
    }
    if (takenAt === null && lat === null) return null;
    return { lat, lon, taken_at: takenAt };
  }

  // --- photo location ---

  function distanceKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // { spot, km } for the spot nearest the photo when that is not the chosen
  // spot and the chosen spot is more than 1.0 km away; otherwise null.
  function suggestSpot(meta, current, spots) {
    if (!meta || typeof meta.lat !== "number" || typeof meta.lon !== "number") return null;
    const at = { lat: meta.lat, lon: meta.lon };
    let nearest = null;
    let nearestKm = Infinity;
    for (const s of spots) {
      const km = distanceKm(at, s);
      if (km < nearestKm) {
        nearest = s;
        nearestKm = km;
      }
    }
    if (!nearest || nearest.name === current.name) return null;
    if (distanceKm(at, current) <= SUGGEST_KM) return null;
    return { spot: nearest, km: nearestKm };
  }

  return {
    jstNow, shiftDay, dateRange, slotStarted, defaultSession, slotForTime, sessionFromPhoto,
    initialObserved, buildRecord, validateRecord, readExif, distanceKm, suggestSpot,
  };
});
```

- [x] **Step 4: テストが通ることを確かめる**

Run: `node --test feedback.test.js`
Expected: `ℹ tests 38`、`ℹ pass 38`、`ℹ fail 0`

- [x] **Step 5: 全体のテストを流す**

Run: `node --test`
Expected: `ℹ tests 192`、`ℹ fail 0`

- [x] **Step 6: コミットする**

```bash
git add feedback.js feedback.test.js
git commit -F - <<'EOF'
feat: add feedback record building and validation

入力パネルの初期値（日本時間の時間帯）、送る記録の組み立て、
ブラウザと Worker で共用する入力チェック、JPEG の EXIF から撮影時刻・
撮影位置を読む処理、撮影位置に近いポイントの提案を feedback.js にまとめた。
DOM には触らない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: 週間予報に採点関数を渡せるようにする（`forecast.js`）

**Files:**
- Modify: `forecast.js`（`weeklyForecast`）
- Test: `forecast.test.js`

**Interfaces:**
- Consumes: Task 1 の `Calibration.apply(rawData, spot, cal)`。テストでだけ使う。
- Produces: `Forecast.weeklyForecast(marine, forecast, dates, bearing, scorer)`
  - `scorer(data)` は `{data, scores}` を返す。省略すると今と同じ `{data, scores: Scoring.scoreSpot(data, bearing)}` になる。
  - 各日の `maxWaveHeight` は、`scorer` が返した `data.wave_height` から取る。
  - データが欠けた時間帯では `scorer` を呼ばない。

- [x] **Step 1: 失敗するテストを書く**

`forecast.test.js` を2か所変える。1つ目は `calibration.js` の読み込み。

置き換える前：
```js
const S = require("./scoring.js");
```
置き換えた後：
```js
const S = require("./scoring.js");
const C = require("./calibration.js");
```

2つ目。ファイルの末尾に次を足す。

```js
// --- weeklyForecast scorer ---

test("weeklyForecast without a scorer matches the default scorer exactly", () => {
  const marine = marineSeries();
  const forecast = forecastSeries();
  const plain = F.weeklyForecast(marine, forecast, WEEK, 90);
  const explicit = F.weeklyForecast(marine, forecast, WEEK, 90, (data) => ({ data, scores: S.scoreSpot(data, 90) }));
  assert.deepEqual(plain, explicit);
});

test("weeklyForecast uses the scorer's data and scores, and maxWaveHeight follows the scored data", () => {
  const scorer = (data) => {
    const scaled = { ...data, wave_height: data.wave_height * 2 };
    return { data: scaled, scores: { ...S.scoreSpot(scaled, 90), total: 7 } };
  };
  const days = F.weeklyForecast(marineSeries(), forecastSeries(), WEEK, 90, scorer);
  assert.equal(days[0].slots.morning.data.wave_height, 2.5);
  assert.equal(days[0].slots.morning.scores.total, 7);
  assert.equal(days[0].maxWaveHeight, 2.5);
});

test("weeklyForecast never calls the scorer for a missing slot", () => {
  const calls = [];
  const scorer = (data) => { calls.push(data); return { data, scores: S.scoreSpot(data, 90) }; };
  const days = F.weeklyForecast(marineSeries(), forecastSeries(), ["2026-09-25", "2026-09-26"], 90, scorer);
  assert.equal(calls.length, 3);
  assert.deepEqual(days[1].slots, { morning: null, afternoon: null, evening: null });
});

test("weeklyForecast with Calibration.apply and no calibration matches the plain weekly forecast", () => {
  const marine = marineSeries({ swell_wave_height: (di, h) => 0.4 + di * 0.3 + h / 100 });
  const forecast = forecastSeries({ windspeed_10m: (di, h) => di + h / 10 });
  const spot = { name: "一宮", bearing: 90 };
  assert.deepEqual(
    F.weeklyForecast(marine, forecast, WEEK, 90, (data) => C.apply(data, spot, null)),
    F.weeklyForecast(marine, forecast, WEEK, 90),
  );
});
```

- [x] **Step 2: テストが失敗することを確かめる**

Run: `node --test forecast.test.js`
Expected: `ℹ tests 21`、`ℹ pass 19`、`ℹ fail 2`
- 失敗するのは次の2件。今の `weeklyForecast` は5番目の引数を無視するため。
  - `weeklyForecast uses the scorer's data and scores, ...`
  - `weeklyForecast never calls the scorer for a missing slot`

- [x] **Step 3: 実装を書く**

`forecast.js` の `weeklyForecast` を次のとおり変える。

**1. `weeklyForecast` に任意の `scorer` を足す**

置き換える前：
```js
  function weeklyForecast(marine, forecast, dates, bearing) {
```
置き換えた後：
```js
  // scorer(data) returns the cell { data, scores }; the app passes one that
  // applies feedback calibration. maxWaveHeight follows the returned data.
  function weeklyForecast(marine, forecast, dates, bearing, scorer) {
    const score = scorer || ((data) => ({ data, scores: Scoring.scoreSpot(data, bearing) }));
```

**2. セルは `score(data)` で作り、最大波高は返ってきた `data` から取る**

置き換える前：
```js
        slots[slot] = data ? { data, scores: Scoring.scoreSpot(data, bearing) } : null;
        if (data) heights.push(data.wave_height);
```
置き換えた後：
```js
        slots[slot] = data ? score(data) : null;
        if (slots[slot]) heights.push(slots[slot].data.wave_height);
```

- [x] **Step 4: テストが通ることを確かめる**

Run: `node --test forecast.test.js`
Expected: `ℹ tests 21`、`ℹ pass 21`、`ℹ fail 0`

- [x] **Step 5: 全体のテストを流す**

Run: `node --test`
Expected: `ℹ tests 196`、`ℹ fail 0`

- [x] **Step 6: コミットする**

```bash
git add forecast.js forecast.test.js
git commit -F - <<'EOF'
feat: let weeklyForecast take a scorer

週間予報の各セルを作る関数を任意で渡せるようにした。渡さなければ今と
同じ結果になる。アプリは補正をかける関数を渡す。最大波高は、返ってきた
（補正後の）波高から取る。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Worker（受け付け・保存・R2 のコスト対策）

**Files:**
- Create: `worker/schema.sql`、`worker/d1-sqlite.mjs`（テスト専用）、`worker/quota.mjs`、`worker/handler.mjs`、`worker/index.mjs`、`worker/wrangler.toml`、`.gitignore`
- Test: `worker/worker.test.mjs`（新規）

**Interfaces:**
- Consumes:
  - Task 1 の `Calibration.compute(records)` と `Calibration.metrics(records)`
  - Task 2 の `Feedback.validateRecord(rec, now)`、`Feedback.jstNow(now)`、`Feedback.shiftDay(date, days)`
  - `.mjs` から UMD の `.js` を default import で読む（`import Calibration from "../calibration.js"`）。
- Produces:
  - `worker/handler.mjs` の `export async function handle(request, env, now)`
    - `env` は `{DB, PHOTOS, ALLOWED_ORIGINS, IP_SALT, R2_KILL_SWITCH}` と、上限の変数（`MAX_UPLOAD_SIZE` など9つ。無ければ `DEFAULT_LIMITS`）。
    - `POST /feedback`（multipart。`record` は JSON の文字列、`photo` は JPEG で任意）
      - 成功：`200 {"ok": true, "id", "updated"}`。写真を置かなかったときは `"photo_skipped": "kill_switch" | "device_bytes" | "global_bytes" | "device_storage" | "global_storage"` が付く。
      - 失敗：`400 {"error", "errors"}` / `403` / `413` / `415` / `429 {"error", "limit"}` / `500 {"error"}`
        - `limit` は `device_minute` / `ip_minute` / `device` / `ip` / `total`。
        - `error` は、`_minute` のとき「短い間に送りすぎです。1分ほど待ってから送ってください」、それ以外は「今日はこれ以上送れません」。
        - 設定が足りない・読めないときも `500`。
    - `OPTIONS /feedback`：CORS の事前確認
    - `GET /calibration`：補正を返す。`?metrics=1` のときだけ `metrics` を足す。`Cache-Control: public, max-age=300` と `Access-Control-Allow-Origin: *` を付ける。
  - `worker/d1-sqlite.mjs` の `export function createD1(db)`：`node:sqlite` の `DatabaseSync` を D1 の `prepare().bind().first()/all()/run()` で使えるようにする。Task 5・6 の確認用 Worker もこれを使う。
  - `worker/quota.mjs` の `DEFAULT_LIMITS`（上限の既定値。Task 7 の文書の表と一致させる）、`readLimits(env)`、`photosAllowed(env)`、`reserve(db, limits, {...})`、`release(db, device, bytes)`。
  - `worker/schema.sql`：`feedback`、`submissions`、`storage_usage` のテーブル。Task 8・9 の wrangler でもそのまま流す。
  - ログ：1回の `POST` ごとに JSON の1行（`event: "feedback"`）。失敗のときは `config_error` / `r2_error` / `d1_error` / `photo_orphan` / `error`。Task 7 の文書の「見張る」の表と一致させる。

- [x] **Step 1: テーブル定義とテスト用の D1 を置く**

`worker/schema.sql` を次の内容で作る。

```sql
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  spot TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD（日本時間）
  slot TEXT NOT NULL,            -- morning | afternoon | evening
  bearing REAL NOT NULL,         -- 送った当時のポイントの向き
  fc_wave_height REAL NOT NULL,  -- ここから5列は補正前の予報
  fc_wind_dir REAL NOT NULL,
  fc_wind_speed REAL NOT NULL,
  fc_swell_dir REAL NOT NULL,
  fc_swell_period REAL NOT NULL,
  rating INTEGER NOT NULL,       -- 1..5
  wave_band INTEGER NOT NULL,    -- 0..7
  wind_side TEXT NOT NULL,       -- off | side | on
  wind_strength TEXT NOT NULL,   -- calm | light | strong
  photo_key TEXT,
  photo_bytes INTEGER,           -- photo_key の写真の大きさ
  photo_lat REAL,
  photo_lon REAL,
  photo_taken_at TEXT,           -- YYYY-MM-DDTHH:MM（日本時間）
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO 8601（UTC）
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, spot, date, slot)
);

-- 受け付けた送信（上限の数え方の元）。3日より前の行は送信のたびに消す。
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,    -- 送信ごとの乱数（同じ batch の次の文がこの行を指すため）
  device_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD（日本時間）
  at INTEGER NOT NULL,           -- 受け付けた時刻（Unix ミリ秒）
  photo_bytes INTEGER NOT NULL DEFAULT 0,  -- R2 に置いてよいとした写真の大きさ（置かないなら 0）
  photo_skipped TEXT             -- 写真を置かなかった理由（kill_switch / device_bytes / ...）
);
CREATE INDEX IF NOT EXISTS submissions_day ON submissions (day);

-- R2 にいま置いてある写真の合計。scope は 'global' と 'device:<device_id>'。
CREATE TABLE IF NOT EXISTS storage_usage (
  scope TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0
);
```

`worker/d1-sqlite.mjs` を次の内容で作る。

```js
// Test-only: wraps node:sqlite in the subset of the D1 API the Worker uses
// (prepare().bind().first()/all()/run() and batch()). Every call first waits
// one turn of the event loop, like the network round trip to D1, so requests
// sent at once interleave between queries as they do in production. batch()
// runs its statements in one transaction: all of them or none. Rows are
// copied into plain objects because node:sqlite returns null-prototype rows.
// node:sqlite does not bind numbered parameters (?1, ?2) by position as D1
// does, so each ?N becomes a plain ? and the values are reordered to match.
const roundTrip = () => new Promise((resolve) => setImmediate(resolve));

export function createD1(db) {
  return {
    prepare(sql) {
      const order = [];
      const stmt = db.prepare(sql.replace(/\?(\d+)/g, (_, n) => {
        order.push(Number(n) - 1);
        return "?";
      }));
      const bound = (bindings) => {
        const params = order.length ? order.map((i) => bindings[i]) : bindings;
        const rows = () => stmt.all(...params).map((row) => ({ ...row }));
        return {
          bind: (...args) => bound(args),
          rows,
          async first() {
            await roundTrip();
            const row = stmt.get(...params);
            return row ? { ...row } : null;
          },
          async all() {
            await roundTrip();
            return { results: rows(), success: true };
          },
          async run() {
            await roundTrip();
            const info = stmt.run(...params);
            return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
          },
        };
      };
      return bound([]);
    },
    async batch(statements) {
      await roundTrip();
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({ results: statement.rows(), success: true }));
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
```

- [x] **Step 2: 失敗するテストを書く**

`worker/worker.test.mjs` を次の内容で作る。R2 は `Map` に入れる作りもので置き換え、D1 は `schema.sql` をそのまま流した `node:sqlite` を使う。

```js
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Calibration from "../calibration.js";
import { handle } from "./handler.mjs";
import { createD1 } from "./d1-sqlite.mjs";

const ORIGIN = "https://tk0407.github.io";
const NOW = new Date("2026-09-23T03:00:00Z"); // 12:00 in Japan
const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

function memoryR2(map) {
  return {
    async put(key, value) {
      map.set(key, new Uint8Array(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

// vars override the Worker variables. Photos are allowed (switch off) unless a test says otherwise.
function setup(vars = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const photos = new Map();
  const env = {
    DB: createD1(sqlite),
    PHOTOS: memoryR2(photos),
    ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8000`,
    IP_SALT: "test-salt",
    R2_KILL_SWITCH: "false",
    ...vars,
  };
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args).map((r) => ({ ...r }));
  const usage = () => rows("SELECT scope, used_bytes, file_count FROM storage_usage ORDER BY scope");
  return { sqlite, photos, env, rows, usage };
}

// A D1 whose statements containing `failsOn` throw, alone or inside a batch.
function failingDb(realDb, failsOn) {
  return {
    prepare(sql) {
      if (!sql.includes(failsOn)) return realDb.prepare(sql);
      const fail = async () => { throw new Error("D1 unavailable"); };
      const broken = { broken: true, bind: () => broken, first: fail, all: fail, run: fail };
      return broken;
    },
    async batch(statements) {
      if (statements.some((s) => s.broken)) throw new Error("D1 unavailable");
      return realDb.batch(statements);
    },
  };
}

// Counts R2 writes without storing anything.
function countPuts(env) {
  const calls = { n: 0 };
  env.PHOTOS.put = async () => { calls.n += 1; };
  return calls;
}

// The Worker logs one JSON line per event with console.log. Keep them out of
// the test output; logging tests call resetCalls() and read them back.
const consoleLog = mock.method(console, "log", () => {});
const loggedLines = () => consoleLog.mock.calls.map((call) => {
  assert.equal(call.arguments.length, 1);
  return call.arguments[0];
});
const logged = () => loggedLines().map((line) => JSON.parse(line));

const deviceId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function record(overrides = {}) {
  return {
    device_id: deviceId(1),
    name: "たろう",
    spot: "一宮",
    date: "2026-09-23",
    slot: "morning",
    bearing: 100,
    forecast: { wave_height: 0.9, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5 },
    observed: { rating: 4, wave_band: 3, wind_side: "off", wind_strength: "light" },
    photo_meta: { lat: 35.34, lon: 140.39, taken_at: "2026-09-23T07:42" },
    ...overrides,
  };
}

function jpeg(size = 64, fill = 1) {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function feedbackRequest({ rec = record(), photo = null, filename = "photo.jpg", ip = "203.0.113.7", origin = ORIGIN, body, contentType } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;
  if (body === undefined) {
    body = new FormData();
    body.append("record", typeof rec === "string" ? rec : JSON.stringify(rec));
    if (photo) body.append("photo", new Blob([photo], { type: "image/jpeg" }), filename);
  }
  return new Request("https://api.example/feedback", { method: "POST", headers, body });
}

async function send(env, options = {}, now = NOW) {
  const res = await handle(feedbackRequest(options), env, now);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// --- POST /feedback ---

test("POST stores one record, the photo and a submission", async () => {
  const { env, photos, rows, usage } = setup();
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, id: 1, updated: false });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const [row] = rows("SELECT * FROM feedback");
  assert.equal(row.spot, "一宮");
  assert.equal(row.name, "たろう");
  assert.equal(row.fc_wave_height, 0.9);
  assert.equal(row.rating, 4);
  assert.equal(row.wind_side, "off");
  assert.equal(row.photo_lat, 35.34);
  assert.equal(row.photo_taken_at, "2026-09-23T07:42");
  assert.match(row.photo_key, /^photos\/[0-9a-f-]{36}\.jpg$/);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.created_at, NOW.toISOString());
  assert.deepEqual([...photos.keys()], [row.photo_key]);
  assert.deepEqual(photos.get(row.photo_key), jpeg());
  assert.equal(row.photo_bytes, 64);
  assert.deepEqual(rows("SELECT day, at, photo_bytes, photo_skipped FROM submissions"), [
    { day: "2026-09-23", at: NOW.getTime(), photo_bytes: 64, photo_skipped: null },
  ]);
  assert.deepEqual(usage(), [
    { scope: `device:${deviceId(1)}`, used_bytes: 64, file_count: 1 },
    { scope: "global", used_bytes: 64, file_count: 1 },
  ]);
});

test("POST without a photo stores null photo fields even when photo_meta is sent", async () => {
  const { env, photos, rows } = setup();
  assert.equal((await send(env)).status, 200);
  const [row] = rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback");
  assert.deepEqual(row, { photo_key: null, photo_lat: null, photo_lon: null, photo_taken_at: null });
  assert.equal(photos.size, 0);
});

test("resending the same session overwrites it and keeps created_at", async () => {
  const { env, rows } = setup();
  await send(env);
  const later = new Date("2026-09-23T04:00:00Z");
  const res = await send(env, { rec: record({ observed: { rating: 2, wave_band: 1, wind_side: "on", wind_strength: "strong" } }) }, later);
  assert.deepEqual(res.body, { ok: true, id: 1, updated: true });
  const all = rows("SELECT rating, wave_band, created_at, updated_at FROM feedback");
  assert.deepEqual(all, [{ rating: 2, wave_band: 1, created_at: NOW.toISOString(), updated_at: later.toISOString() }]);
  assert.equal(rows("SELECT * FROM submissions").length, 2);
});

test("a different slot, date or spot from the same device is a separate record", async () => {
  const { env, rows } = setup();
  await send(env);
  await send(env, { rec: record({ slot: "afternoon" }) });
  await send(env, { rec: record({ date: "2026-09-22" }) });
  await send(env, { rec: record({ spot: "志田下" }) });
  assert.equal(rows("SELECT * FROM feedback").length, 4);
});

test("resending without a photo keeps the earlier photo and its location", async () => {
  const { env, photos, rows } = setup();
  await send(env, { photo: jpeg() });
  const [before] = rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback");
  await send(env, { rec: record({ photo_meta: null }) });
  assert.deepEqual(rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback"), [before]);
  assert.deepEqual([...photos.keys()], [before.photo_key]);
});

test("resending with a new photo replaces the file, deletes the old one and counts only the new one", async () => {
  const { env, photos, rows, usage } = setup();
  await send(env, { photo: jpeg(1000, 1) });
  const [{ photo_key: oldKey }] = rows("SELECT photo_key FROM feedback");
  await send(env, { photo: jpeg(600, 2), rec: record({ photo_meta: { lat: 35.1, lon: 140.2, taken_at: null } }) });
  const [row] = rows("SELECT photo_key, photo_lat, photo_taken_at, photo_bytes FROM feedback");
  assert.notEqual(row.photo_key, oldKey);
  assert.equal(row.photo_lat, 35.1);
  assert.equal(row.photo_taken_at, null);
  assert.equal(row.photo_bytes, 600);
  assert.deepEqual([...photos.keys()], [row.photo_key]);
  assert.deepEqual(photos.get(row.photo_key), jpeg(600, 2));
  assert.deepEqual(usage(), [
    { scope: `device:${deviceId(1)}`, used_bytes: 600, file_count: 1 },
    { scope: "global", used_bytes: 600, file_count: 1 },
  ]);
});

test("the photo key is made by the server, whatever the record or the file name says", async () => {
  const { env, photos, rows } = setup();
  const res = await send(env, { photo: jpeg(), rec: record({ photo_key: "../other/x.jpg" }), filename: "../../evil.jpg" });
  assert.equal(res.status, 200);
  const [{ photo_key }] = rows("SELECT photo_key FROM feedback");
  assert.match(photo_key, /^photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/);
  assert.deepEqual([...photos.keys()], [photo_key]);
});

test("an invalid record gets 400 naming the field, and nothing is stored", async () => {
  const { env, photos, rows } = setup();
  const res = await send(env, { photo: jpeg(), rec: record({ observed: { rating: 9, wave_band: 3, wind_side: "off", wind_strength: "light" } }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /observed\.rating/);
  assert.deepEqual(res.body.errors.map((e) => e.split(":")[0]), ["observed.rating"]);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
  assert.equal(rows("SELECT * FROM submissions").length, 0);
  assert.equal(photos.size, 0);
});

test("malformed bodies get 400, not 500", async () => {
  const { env, rows } = setup();
  const notJson = await send(env, { rec: "{" });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^record:/);

  const missing = new FormData();
  missing.append("other", "x");
  assert.equal((await send(env, { body: missing })).status, 400);

  const plain = await send(env, { body: "hello", contentType: "text/plain" });
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const brokenMultipart = await send(env, { body: "--x\r\nbroken", contentType: "multipart/form-data; boundary=x" });
  assert.equal(brokenMultipart.status, 400);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a photo that is not a JPEG gets 415", async () => {
  const { env, photos } = setup();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal((await send(env, { photo: png })).status, 415);
  assert.equal((await send(env, { photo: new Uint8Array(0) })).status, 415);
  assert.equal(photos.size, 0);
});

test("photos are accepted up to 1,572,864 bytes and rejected with 413 above", async () => {
  const { env, photos } = setup();
  assert.equal((await send(env, { photo: jpeg(1572864) })).status, 200);
  assert.equal((await send(env, { photo: jpeg(1572865) })).status, 413);
  assert.equal(photos.size, 1);
});

test("a request body over 2 MB gets 413", async () => {
  const { env, rows } = setup();
  const res = await send(env, { photo: jpeg(2 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a streamed body without Content-Length stops being read soon after the limit", async () => {
  const { env, rows } = setup();
  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled >= 50 * 1024 * 1024) return controller.close();
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("https://api.example/feedback", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "multipart/form-data; boundary=x" },
  });
  const res = await handle(request, env, NOW);
  assert.equal(res.status, 413);
  assert.ok(pulled < 3 * 1024 * 1024, `read ${pulled} bytes`);
  assert.equal(rows("SELECT * FROM submissions").length, 0);
});

test("MAX_UPLOAD_SIZE sets the photo limit, up to a ceiling of 10 MB", async () => {
  const small = setup({ MAX_UPLOAD_SIZE: "1000" });
  assert.equal((await send(small.env, { photo: jpeg(1000) })).status, 200);
  assert.equal((await send(small.env, { photo: jpeg(1001), rec: record({ slot: "afternoon" }) })).status, 413);
  assert.equal(small.photos.size, 1);

  const ceiling = setup({ MAX_UPLOAD_SIZE: String(10 * 1024 * 1024) });
  assert.equal((await send(ceiling.env, { photo: jpeg(2 * 1024 * 1024) })).status, 200);
});

test("limit variables that are not whole numbers make POST fail closed with 500", async () => {
  const cases = [
    ["DAILY_UPLOAD_COUNT_LIMIT", "10MB"],
    ["GLOBAL_STORAGE_LIMIT", "-1"],
    ["MINUTE_COUNT_LIMIT", "1.5"],
    ["USER_STORAGE_LIMIT", "1e6"],
    ["MAX_UPLOAD_SIZE", String(10 * 1024 * 1024 + 1)],
  ];
  for (const [name, value] of cases) {
    const { env, rows } = setup({ [name]: value });
    const puts = countPuts(env);
    consoleLog.mock.resetCalls();
    const res = await send(env, { photo: jpeg() });
    assert.equal(res.status, 500, name);
    assert.equal(rows("SELECT * FROM feedback").length, 0, name);
    assert.equal(rows("SELECT * FROM submissions").length, 0, name);
    assert.equal(puts.n, 0, name);
    assert.deepEqual(logged()[0], { event: "config_error", variable: name });
  }
});

test("an empty or blank limit variable falls back to the default", async () => {
  const { env } = setup({ MAX_UPLOAD_SIZE: "", DAILY_UPLOAD_COUNT_LIMIT: "  " });
  assert.equal((await send(env, { photo: jpeg(1572864) })).status, 200);
  assert.equal((await send(env, { photo: jpeg(1572865), rec: record({ slot: "afternoon" }) })).status, 413);
});

// --- photo kill switch ---

test("photos are not stored unless R2_KILL_SWITCH is false or 0, but the record is", async () => {
  for (const value of [undefined, "", "true", "yes", "on"]) {
    const { env, rows, usage } = setup({ R2_KILL_SWITCH: value });
    const puts = countPuts(env);
    const res = await send(env, { photo: jpeg() });
    assert.deepEqual(res.body, { ok: true, id: 1, updated: false, photo_skipped: "kill_switch" }, String(value));
    assert.equal(puts.n, 0);
    assert.deepEqual(rows("SELECT rating, photo_key, photo_lat, photo_bytes FROM feedback"), [
      { rating: 4, photo_key: null, photo_lat: null, photo_bytes: null },
    ]);
    assert.deepEqual(rows("SELECT photo_bytes, photo_skipped FROM submissions"), [{ photo_bytes: 0, photo_skipped: "kill_switch" }]);
    assert.deepEqual(usage(), []);
    const noPhoto = await send(env, { rec: record({ slot: "afternoon" }) });
    assert.deepEqual(noPhoto.body, { ok: true, id: 2, updated: false });
  }
});

test("R2_KILL_SWITCH false or 0, in any case and with spaces, lets photos through", async () => {
  for (const value of ["false", "FALSE", " 0 "]) {
    const { env, photos } = setup({ R2_KILL_SWITCH: value });
    const res = await send(env, { photo: jpeg() });
    assert.deepEqual(res.body, { ok: true, id: 1, updated: false }, value);
    assert.equal(photos.size, 1);
  }
});

// --- daily limits ---

test("the 21st submission from one device in a day gets 429 device", async () => {
  const { env } = setup({ MINUTE_COUNT_LIMIT: "100" });
  for (let i = 0; i < 20; i++) assert.equal((await send(env, { ip: `198.51.100.${i}` })).status, 200);
  const res = await send(env, { ip: "198.51.100.99" });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "device");
});

test("the 31st submission from one connection in a day gets 429 ip", async () => {
  const { env } = setup({ MINUTE_COUNT_LIMIT: "100" });
  for (let i = 0; i < 30; i++) assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }) })).status, 200);
  const res = await send(env, { rec: record({ device_id: deviceId(99) }) });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "ip");
});

test("the 101st submission in a day overall gets 429 total", async () => {
  const { env } = setup();
  for (let i = 0; i < 100; i++) {
    assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }), ip: `10.0.${i >> 8}.${i & 255}` })).status, 200);
  }
  const res = await send(env, { rec: record({ device_id: deviceId(500) }), ip: "192.0.2.1" });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "total");
});

test("GLOBAL_DAILY_COUNT_LIMIT 0 refuses every send, so it stops intake in an emergency", async () => {
  const { env, rows } = setup({ GLOBAL_DAILY_COUNT_LIMIT: "0" });
  const puts = countPuts(env);
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "total");
  assert.equal(puts.n, 0);
  assert.deepEqual(rows("SELECT id FROM feedback"), []);
  assert.deepEqual(rows("SELECT id FROM submissions"), []);
});

test("limits restart at midnight Japan time even though the clock is UTC", async () => {
  const { env, rows } = setup({ MINUTE_COUNT_LIMIT: "100" });
  const lastMinute = new Date("2026-09-23T14:59:00Z"); // 23:59 on the 23rd in Japan
  const midnight = new Date("2026-09-23T15:00:00Z"); // 00:00 on the 24th in Japan
  for (let i = 0; i < 20; i++) assert.equal((await send(env, {}, lastMinute)).status, 200);
  assert.equal((await send(env, {}, lastMinute)).status, 429);
  assert.equal((await send(env, {}, midnight)).status, 200);
  assert.deepEqual(rows("SELECT day, COUNT(*) AS n FROM submissions GROUP BY day ORDER BY day"), [
    { day: "2026-09-23", n: 20 },
    { day: "2026-09-24", n: 1 },
  ]);
});

test("each submission purges submission rows older than 3 days", async () => {
  const { env, sqlite, rows } = setup();
  const insert = sqlite.prepare("INSERT INTO submissions (token, device_id, ip_hash, day, at) VALUES (?, 'd', 'h', ?, 0)");
  for (const day of ["2026-09-19", "2026-09-20", "2026-09-22"]) insert.run(day, day);
  await send(env);
  assert.deepEqual(rows("SELECT day FROM submissions ORDER BY day").map((r) => r.day), ["2026-09-20", "2026-09-22", "2026-09-23"]);
});

test("the 6th send from one device within a minute gets 429 device_minute until 60 s have passed", async () => {
  const { env } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await send(env, { ip: `198.51.100.${i}` })).status, 200);
  const sixth = await send(env, { ip: "198.51.100.9" });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.limit, "device_minute");
  assert.equal((await send(env, { ip: "198.51.100.9" }, new Date(NOW.getTime() + 59999))).body.limit, "device_minute");
  assert.equal((await send(env, { ip: "198.51.100.9" }, new Date(NOW.getTime() + 60000))).status, 200);
});

test("the 6th send from one connection within a minute gets 429 ip_minute", async () => {
  const { env } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }) })).status, 200);
  const sixth = await send(env, { rec: record({ device_id: deviceId(9) }) });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.limit, "ip_minute");
});

test("25 sends at once from one device store exactly the daily 20", async () => {
  const { env, rows } = setup({ MINUTE_COUNT_LIMIT: "100" });
  const results = await Promise.all(Array.from({ length: 25 }, () => send(env)));
  assert.equal(results.filter((r) => r.status === 200).length, 20);
  assert.deepEqual(results.filter((r) => r.status !== 200).map((r) => [r.status, r.body.limit]), Array(5).fill([429, "device"]));
  assert.equal(rows("SELECT * FROM submissions").length, 20);
});

// --- photo storage limits: the record is kept, only the photo is skipped ---

test("DAILY_UPLOAD_LIMIT skips photos past one device's bytes for the day", async () => {
  const { env, photos, rows } = setup({ DAILY_UPLOAD_LIMIT: "2000" });
  assert.deepEqual((await send(env, { photo: jpeg(1000) })).body, { ok: true, id: 1, updated: false });
  assert.deepEqual((await send(env, { photo: jpeg(1000), rec: record({ slot: "afternoon" }) })).body, { ok: true, id: 2, updated: false });
  const third = await send(env, { photo: jpeg(1000), rec: record({ slot: "evening", date: "2026-09-22" }) });
  assert.deepEqual(third.body, { ok: true, id: 3, updated: false, photo_skipped: "device_bytes" });
  assert.deepEqual(rows("SELECT photo_key FROM feedback WHERE id = 3"), [{ photo_key: null }]);
  assert.equal(photos.size, 2);
  const other = await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(2) }) });
  assert.equal("photo_skipped" in other.body, false);
  assert.equal(photos.size, 3);
});

test("GLOBAL_DAILY_UPLOAD_LIMIT skips photos past the day's total bytes", async () => {
  const { env, photos } = setup({ GLOBAL_DAILY_UPLOAD_LIMIT: "2000" });
  for (const i of [1, 2]) assert.equal("photo_skipped" in (await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(i) }) })).body, false);
  const third = await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(3) }) });
  assert.equal(third.status, 200);
  assert.equal(third.body.photo_skipped, "global_bytes");
  assert.equal(photos.size, 2);
});

test("USER_STORAGE_LIMIT skips photos once a device's stored photos reach it, on later days too", async () => {
  const { env, photos } = setup({ USER_STORAGE_LIMIT: "2000" });
  await send(env, { photo: jpeg(1000) });
  await send(env, { photo: jpeg(1000), rec: record({ slot: "afternoon" }) });
  assert.equal((await send(env, { photo: jpeg(1000), rec: record({ date: "2026-09-22" }) })).body.photo_skipped, "device_storage");
  const nextDay = new Date(NOW.getTime() + 24 * 3600 * 1000);
  assert.equal((await send(env, { photo: jpeg(1000), rec: record({ date: "2026-09-24" }) }, nextDay)).body.photo_skipped, "device_storage");
  assert.equal("photo_skipped" in (await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(2) }) })).body, false);
  assert.equal(photos.size, 3);
});

test("GLOBAL_STORAGE_LIMIT holds when 10 devices send photos at once", async () => {
  const { env, photos, usage } = setup({ GLOBAL_STORAGE_LIMIT: "3000" });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(i) }), ip: `198.51.100.${i}` })));
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(results.map((r) => r.body.photo_skipped).filter(Boolean), Array(7).fill("global_storage"));
  assert.equal(photos.size, 3);
  assert.deepEqual(usage().find((u) => u.scope === "global"), { scope: "global", used_bytes: 3000, file_count: 3 });
});

// --- CORS and configuration ---

test("allowed origins get CORS headers on OPTIONS and POST", async () => {
  const { env } = setup();
  for (const origin of [ORIGIN, "http://localhost:8000"]) {
    const res = await handle(new Request("https://api.example/feedback", { method: "OPTIONS", headers: { Origin: origin } }), env, NOW);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
    assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
  }
  assert.equal((await send(env, { origin: "http://localhost:8000" })).headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
});

test("other or missing origins get 403 and nothing is stored", async () => {
  const { env, rows } = setup();
  const options = await handle(new Request("https://api.example/feedback", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env, NOW);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await send(env, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send(env, { origin: null })).status, 403);
  assert.equal((await send(env, { origin: `${ORIGIN}.evil.example` })).status, 403);
  assert.equal((await send(env, { origin: "https://tk0407.github" })).status, 403); // a prefix of an allowed origin
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a missing IP_SALT gets 500 and nothing is stored", async () => {
  const { env, rows } = setup();
  delete env.IP_SALT;
  assert.equal((await send(env)).status, 500);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

// --- failures of R2 and D1 ---

test("when saving the record fails, the uploaded photo is removed, its bytes given back and 500 returned", async () => {
  const { env, photos, rows, usage } = setup();
  env.DB = failingDb(env.DB, "INSERT INTO feedback");
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "保存できませんでした");
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => [u.used_bytes, u.file_count]), [[0, 0], [0, 0]]);
  assert.equal(rows("SELECT * FROM submissions").length, 1); // the attempt still counts toward the limits
  assert.ok(logged().some((e) => e.event === "d1_error"));
});

test("when the database cannot take the send, no photo is uploaded", async () => {
  const { env, rows } = setup();
  env.DB = failingDb(env.DB, "INSERT INTO submissions");
  const puts = countPuts(env);
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 500);
  assert.equal(puts.n, 0);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("when the photo upload fails, nothing is saved and its bytes are given back", async () => {
  const { env, photos, rows, usage } = setup();
  env.PHOTOS.put = async () => { throw new Error("R2 returned 500"); };
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg(1000) });
  assert.equal(res.status, 500);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => [u.used_bytes, u.file_count]), [[0, 0], [0, 0]]);
  assert.deepEqual(logged().map((e) => e.event), ["r2_error", "feedback"]);
});

test("an upload that times out after writing leaves no object behind", async () => {
  const { env, photos, usage } = setup();
  const realPut = env.PHOTOS.put;
  env.PHOTOS.put = async (...args) => {
    await realPut(...args);
    throw new Error("timed out");
  };
  assert.equal((await send(env, { photo: jpeg(1000) })).status, 500);
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => u.used_bytes), [0, 0]);
});

test("when the old photo cannot be deleted, the send still succeeds and the orphan is logged", async () => {
  const { env, photos, rows, usage } = setup();
  await send(env, { photo: jpeg(1000) });
  const [{ photo_key: oldKey }] = rows("SELECT photo_key FROM feedback");
  env.PHOTOS.delete = async () => { throw new Error("R2 returned 500"); };
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg(600) });
  assert.deepEqual(res.body, { ok: true, id: 1, updated: true });
  assert.equal(photos.size, 2);
  assert.deepEqual(usage().find((u) => u.scope === "global"), { scope: "global", used_bytes: 1600, file_count: 2 });
  assert.ok(logged().some((e) => e.event === "photo_orphan" && e.key === oldKey));
});

// --- logs ---

test("each POST logs JSON lines that hold no personal data", async () => {
  const { env, rows } = setup({ DAILY_UPLOAD_COUNT_LIMIT: "1" });
  consoleLog.mock.resetCalls();
  await send(env, { photo: jpeg() });
  await send(env, { rec: record({ observed: { rating: 9, wave_band: 3, wind_side: "off", wind_strength: "light" } }) });
  await send(env, { rec: record({ slot: "afternoon" }) });
  assert.deepEqual(logged(), [
    { event: "feedback", status: 200, photo_bytes: 64, updated: false },
    { event: "feedback", status: 400 },
    { event: "feedback", status: 429, limit: "device" },
  ]);
  const text = loggedLines().join("\n");
  const [{ ip_hash }] = rows("SELECT ip_hash FROM feedback");
  for (const secret of [deviceId(1), "たろう", "203.0.113.7", ip_hash, "test-salt"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("unknown paths get 404 and GET /feedback gets 405", async () => {
  const { env } = setup();
  assert.equal((await handle(new Request("https://api.example/nope"), env, NOW)).status, 404);
  assert.equal((await handle(new Request("https://api.example/feedback"), env, NOW)).status, 405);
});

// --- GET /calibration ---

const getCalibration = async (env, query = "") => {
  const res = await handle(new Request(`https://api.example/calibration${query}`), env, NOW);
  return { status: res.status, headers: res.headers, text: await res.clone().text(), body: await res.json() };
};

test("GET /calibration with no records returns the default weights", async () => {
  const { env } = setup();
  const res = await getCalibration(env);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    version: 1,
    n: 0,
    spots: {},
    weights: { ...Calibration.DEFAULT_WEIGHTS },
    weights_learned: false,
    generated_at: NOW.toISOString(),
  });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
});

test("GET /calibration matches Calibration.compute and leaks no personal data", async () => {
  const { env, rows } = setup();
  for (let i = 0; i < 3; i++) {
    const forecast = { wave_height: 0.6, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5 };
    await send(env, { rec: record({ device_id: deviceId(i), forecast }), photo: jpeg() });
  }
  const res = await getCalibration(env);
  const stored = rows("SELECT * FROM feedback ORDER BY id");
  const { generated_at, ...cal } = res.body;
  assert.deepEqual(cal, Calibration.compute(stored));
  assert.equal(cal.n, 3);
  assert.ok(cal.spots["一宮"].wave_factor > 1);
  assert.equal("metrics" in res.body, false);
  for (const secret of ["たろう", deviceId(0), "photos/", "35.34", stored[0].ip_hash]) {
    assert.equal(res.text.includes(secret), false, secret);
  }
});

test("GET /calibration?metrics=1 adds leave-one-out metrics", async () => {
  const { env, rows } = setup();
  for (let i = 0; i < 3; i++) await send(env, { rec: record({ device_id: deviceId(i) }) });
  const res = await getCalibration(env, "?metrics=1");
  assert.deepEqual(res.body.metrics, Calibration.metrics(rows("SELECT * FROM feedback ORDER BY id")));
  assert.equal(res.body.metrics.n, 3);
});
```

- [x] **Step 3: テストが失敗することを確かめる**

Run: `node --test worker/worker.test.mjs`
Expected: FAIL。`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../worker/handler.mjs'`

- [x] **Step 4: 実装を書く**

`worker/quota.mjs` を次の内容で作る。

```js
// Limits on POST /feedback and the D1 bookkeeping that enforces them. A send
// is checked and recorded in one D1 transaction, so sends arriving at the
// same moment cannot all slip under a limit. docs/r2-security.md explains
// each limit and how to change it.

// Each can be overridden by a Worker variable of the same name.
export const DEFAULT_LIMITS = {
  MAX_UPLOAD_SIZE: 1572864, // bytes in one photo (1.5 MB)
  MINUTE_COUNT_LIMIT: 5, // sends per device, and per connection, in any 60 s
  DAILY_UPLOAD_COUNT_LIMIT: 20, // sends per device per day (Japan time)
  IP_DAILY_COUNT_LIMIT: 30, // sends per connection per day
  GLOBAL_DAILY_COUNT_LIMIT: 100, // sends per day from everyone
  DAILY_UPLOAD_LIMIT: 10485760, // photo bytes per device per day (10 MB)
  GLOBAL_DAILY_UPLOAD_LIMIT: 104857600, // photo bytes per day from everyone (100 MB)
  USER_STORAGE_LIMIT: 209715200, // photo bytes kept in R2 per device (200 MB)
  GLOBAL_STORAGE_LIMIT: 5368709120, // photo bytes kept in R2 in all (5 GB, half the free 10 GB)
};
export const MAX_UPLOAD_SIZE_CEILING = 10485760;

export class ConfigError extends Error {
  constructor(variable) {
    super(`${variable} is not a valid limit`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

// Unset or blank variables take the default. Anything else must be a whole
// number, or the Worker refuses to store anything rather than guess.
export function readLimits(env) {
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const text = String(env[name] ?? "").trim();
    if (text === "") limits[name] = fallback;
    else if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) limits[name] = Number(text);
    else throw new ConfigError(name);
  }
  if (limits.MAX_UPLOAD_SIZE > MAX_UPLOAD_SIZE_CEILING) throw new ConfigError("MAX_UPLOAD_SIZE");
  return limits;
}

// Photos go to R2 only while R2_KILL_SWITCH is "false" or "0". A missing or
// mistyped value leaves the switch on, so a bad deploy cannot start writing.
export function photosAllowed(env) {
  return ["false", "0"].includes(String(env.R2_KILL_SWITCH ?? "").trim().toLowerCase());
}

// Bound as ?6..?13 after ?1 device, ?2 ip_hash, ?3 day, ?4 now (ms) and
// ?5 the photo bytes wanted (0 for none).
const LIMIT_ORDER = [
  "MINUTE_COUNT_LIMIT", "DAILY_UPLOAD_COUNT_LIMIT", "IP_DAILY_COUNT_LIMIT", "GLOBAL_DAILY_COUNT_LIMIT",
  "DAILY_UPLOAD_LIMIT", "GLOBAL_DAILY_UPLOAD_LIMIT", "USER_STORAGE_LIMIT", "GLOBAL_STORAGE_LIMIT",
];

// reason: why the send is refused (429), checked in this order.
// photo_reason: why the photo is skipped though the record is kept.
// TOTAL() is 0 when no row matches.
const VERDICT = `SELECT
    CASE
      WHEN TOTAL(device_id = ?1 AND at > ?4 - 60000) >= ?6 THEN 'device_minute'
      WHEN TOTAL(ip_hash = ?2 AND at > ?4 - 60000) >= ?6 THEN 'ip_minute'
      WHEN TOTAL(device_id = ?1 AND day = ?3) >= ?7 THEN 'device'
      WHEN TOTAL(ip_hash = ?2 AND day = ?3) >= ?8 THEN 'ip'
      WHEN TOTAL(day = ?3) >= ?9 THEN 'total'
    END AS reason,
    CASE
      WHEN ?5 = 0 THEN NULL
      WHEN ?5 + TOTAL(CASE WHEN device_id = ?1 AND day = ?3 THEN photo_bytes END) > ?10 THEN 'device_bytes'
      WHEN ?5 + TOTAL(CASE WHEN day = ?3 THEN photo_bytes END) > ?11 THEN 'global_bytes'
      WHEN ?5 + (SELECT TOTAL(used_bytes) FROM storage_usage WHERE scope = 'device:' || ?1) > ?12 THEN 'device_storage'
      WHEN ?5 + (SELECT TOTAL(used_bytes) FROM storage_usage WHERE scope = 'global') > ?13 THEN 'global_storage'
    END AS photo_reason
  FROM submissions`;

// Records the send only when no count limit is reached. ?14 is a fresh
// token, ?15 a reason the caller already has to skip the photo (or null).
const RESERVE = `INSERT INTO submissions (token, device_id, ip_hash, day, at, photo_bytes, photo_skipped)
  SELECT ?14, ?1, ?2, ?3, ?4, CASE WHEN photo_reason IS NULL THEN ?5 ELSE 0 END, COALESCE(?15, photo_reason)
  FROM (${VERDICT}) WHERE reason IS NULL
  RETURNING photo_bytes, photo_skipped`;

// Adds the photo reserved under token ?1 to the device's and the global totals.
const COUNT_STORAGE = `INSERT INTO storage_usage (scope, used_bytes, file_count)
  SELECT scope, photo_bytes, 1 FROM (
    SELECT 'global' AS scope, photo_bytes FROM submissions WHERE token = ?1 AND photo_bytes > 0
    UNION ALL
    SELECT 'device:' || device_id, photo_bytes FROM submissions WHERE token = ?1 AND photo_bytes > 0
  ) WHERE true
  ON CONFLICT (scope) DO UPDATE SET used_bytes = used_bytes + excluded.used_bytes, file_count = file_count + 1`;

const RELEASE = `UPDATE storage_usage SET used_bytes = MAX(0, used_bytes - ?1), file_count = MAX(0, file_count - 1)
  WHERE scope IN ('global', 'device:' || ?2)`;

// Returns { limit } when a count limit refuses the send. Otherwise the send is
// recorded and it returns { photoBytes, photoSkipped }: the bytes the caller
// may now put in R2 (0 when the photo must be skipped) and why it is skipped.
export async function reserve(db, limits, { device, ipHash, day, at, bytes, skipped = null }) {
  const verdict = [device, ipHash, day, at, bytes, ...LIMIT_ORDER.map((name) => limits[name])];
  const token = crypto.randomUUID();
  const [reserved] = await db.batch([
    db.prepare(RESERVE).bind(...verdict, token, skipped),
    db.prepare(COUNT_STORAGE).bind(token),
  ]);
  const row = reserved.results[0];
  if (row) return { photoBytes: row.photo_bytes, photoSkipped: row.photo_skipped };
  const { reason } = await db.prepare(VERDICT).bind(...verdict).first();
  return { limit: reason };
}

// Gives the bytes of a photo that is gone from R2 back to both totals.
export async function release(db, device, bytes) {
  await db.prepare(RELEASE).bind(bytes, device).run();
}
```

`worker/handler.mjs` を次の内容で作る。

```js
// POST /feedback stores one session record (and optional photo);
// GET /calibration returns the corrections computed from all records.
import Calibration from "../calibration.js";
import Feedback from "../feedback.js";
import { ConfigError, photosAllowed, readLimits, release, reserve } from "./quota.mjs";

// Room for the record and the multipart framing on top of the photo.
const FORM_OVERHEAD_BYTES = 524288;
const KEEP_SUBMISSION_DAYS = 3;
const MAX_LOGGED_ERROR = 200;

const CALIBRATION_COLUMNS =
  "device_id, spot, bearing, fc_wave_height, fc_wind_dir, fc_wind_speed, fc_swell_dir, fc_swell_period, rating, wave_band, wind_side, wind_strength";

const UPSERT = `INSERT INTO feedback (device_id, name, spot, date, slot, bearing,
    fc_wave_height, fc_wind_dir, fc_wind_speed, fc_swell_dir, fc_swell_period,
    rating, wave_band, wind_side, wind_strength,
    photo_key, photo_bytes, photo_lat, photo_lon, photo_taken_at, ip_hash, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (device_id, spot, date, slot) DO UPDATE SET
    name = excluded.name, bearing = excluded.bearing,
    fc_wave_height = excluded.fc_wave_height, fc_wind_dir = excluded.fc_wind_dir,
    fc_wind_speed = excluded.fc_wind_speed, fc_swell_dir = excluded.fc_swell_dir,
    fc_swell_period = excluded.fc_swell_period,
    rating = excluded.rating, wave_band = excluded.wave_band,
    wind_side = excluded.wind_side, wind_strength = excluded.wind_strength,
    photo_key = COALESCE(excluded.photo_key, feedback.photo_key),
    photo_bytes = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_bytes ELSE excluded.photo_bytes END,
    photo_lat = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_lat ELSE excluded.photo_lat END,
    photo_lon = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_lon ELSE excluded.photo_lon END,
    photo_taken_at = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_taken_at ELSE excluded.photo_taken_at END,
    ip_hash = excluded.ip_hash, updated_at = excluded.updated_at
  RETURNING id`;

const SELECT_SESSION = "SELECT id, photo_key, photo_bytes FROM feedback WHERE device_id = ? AND spot = ? AND date = ? AND slot = ?";

// One JSON line per event, read with `wrangler tail`. Never log device ids,
// names, IPs or their hashes.
const log = (entry) => console.log(JSON.stringify(entry));
const errorText = (e) => `${e && e.name}: ${e && e.message}`.slice(0, MAX_LOGGED_ERROR);

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigin(origin, env) {
  if (!origin) return false;
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(origin);
}

const corsFor = (origin) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

// Reads the body but stops, and returns null, as soon as it passes max bytes,
// so a huge or endless upload is never read to the end.
async function readBody(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handle(request, env, now) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (url.pathname === "/feedback") {
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: { ...corsFor(origin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method !== "POST") return json({ error: "POST で送ってください" }, 405);
    if (!allowedOrigin(origin, env)) return json({ error: "このサイトからは送れません" }, 403);
    let res;
    try {
      res = await postFeedback(request, env, now);
    } catch (e) {
      log({ event: "error", error: errorText(e) });
      res = { status: 500, body: { error: "サーバーでエラーが起きました" } };
    }
    const { limit, updated, photo_skipped } = res.body;
    log({ event: "feedback", status: res.status, limit, updated, photo_skipped, photo_bytes: res.photoBytes || undefined });
    return json(res.body, res.status, corsFor(origin));
  }
  if (url.pathname === "/calibration" && request.method === "GET") return getCalibration(url, env, now);
  return json({ error: "見つかりません" }, 404);
}

// Returns { status, body, photoBytes }; handle() turns it into the response
// and the log line.
async function postFeedback(request, env, now) {
  const reply = (status, body, photoBytes = 0) => ({ status, body, photoBytes });
  if (!env.IP_SALT) {
    log({ event: "config_error", variable: "IP_SALT" });
    return reply(500, { error: "サーバーの設定が足りません" });
  }
  let limits;
  try {
    limits = readLimits(env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log({ event: "config_error", variable: e.variable });
    return reply(500, { error: "サーバーの設定が正しくありません" });
  }

  const maxBody = limits.MAX_UPLOAD_SIZE + FORM_OVERHEAD_BYTES;
  if (Number(request.headers.get("Content-Length")) > maxBody) return reply(413, { error: "送信が大きすぎます" });
  const body = await readBody(request, maxBody);
  if (!body) return reply(413, { error: "送信が大きすぎます" });

  let form;
  try {
    form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
  } catch (e) {
    return reply(400, { error: "送信の形が正しくありません" });
  }
  let rec;
  try {
    rec = JSON.parse(form.get("record"));
  } catch (e) {
    return reply(400, { error: "record: JSON ではありません" });
  }
  const errors = Feedback.validateRecord(rec, now);
  if (errors.length) return reply(400, { error: errors.join(" / "), errors });

  const photo = form.get("photo");
  let photoBytes = null;
  if (photo !== null) {
    if (typeof photo === "string") return reply(415, { error: "写真は JPEG にしてください" });
    photoBytes = new Uint8Array(await photo.arrayBuffer());
    if (photoBytes.byteLength > limits.MAX_UPLOAD_SIZE) return reply(413, { error: "写真が大きすぎます" });
    if (!isJpeg(photoBytes)) return reply(415, { error: "写真は JPEG にしてください" });
  }

  const day = Feedback.jstNow(now).date;
  const ipHash = await sha256Hex((request.headers.get("CF-Connecting-IP") || "") + env.IP_SALT);
  const killed = photoBytes !== null && !photosAllowed(env);
  const reservation = await reserve(env.DB, limits, {
    device: rec.device_id,
    ipHash,
    day,
    at: now.getTime(),
    bytes: photoBytes && !killed ? photoBytes.byteLength : 0,
    skipped: killed ? "kill_switch" : null,
  });
  if (reservation.limit) {
    const error = reservation.limit.endsWith("_minute") ? "短い間に送りすぎです。1分ほど待ってから送ってください" : "今日はこれ以上送れません";
    return reply(429, { error, limit: reservation.limit });
  }

  // The key is always made here: nothing the sender writes reaches it.
  const photoKey = reservation.photoBytes > 0 ? `photos/${crypto.randomUUID()}.jpg` : null;
  if (photoKey) {
    try {
      await env.PHOTOS.put(photoKey, photoBytes, { httpMetadata: { contentType: "image/jpeg" } });
    } catch (e) {
      log({ event: "r2_error", error: errorText(e) });
      await discardPhoto(env, photoKey, reservation.photoBytes, rec.device_id);
      return reply(500, { error: "保存できませんでした" });
    }
  }

  const meta = (photoKey && rec.photo_meta) || {};
  const stamp = now.toISOString();
  let before, saved;
  try {
    // Reading the old row in the same transaction tells exactly which photo
    // this save replaced, even when two sends of the same session race.
    [before, saved] = await env.DB.batch([
      env.DB.prepare(SELECT_SESSION).bind(rec.device_id, rec.spot, rec.date, rec.slot),
      env.DB.prepare(UPSERT).bind(
        rec.device_id, rec.name.trim(), rec.spot, rec.date, rec.slot, rec.bearing,
        rec.forecast.wave_height, rec.forecast.wind_dir, rec.forecast.wind_speed, rec.forecast.swell_dir, rec.forecast.swell_period,
        rec.observed.rating, rec.observed.wave_band, rec.observed.wind_side, rec.observed.wind_strength,
        photoKey, photoKey ? reservation.photoBytes : null, meta.lat ?? null, meta.lon ?? null, meta.taken_at ?? null,
        ipHash, stamp, stamp,
      ),
    ]);
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
    if (photoKey) await discardPhoto(env, photoKey, reservation.photoBytes, rec.device_id);
    return reply(500, { error: "保存できませんでした" });
  }
  const old = before.results[0] || null;
  await afterSave(env, day, photoKey && old && old.photo_key ? old : null, rec.device_id);

  const result = { ok: true, id: saved.results[0].id, updated: Boolean(old) };
  if (reservation.photoSkipped) result.photo_skipped = reservation.photoSkipped;
  return reply(200, result, reservation.photoBytes);
}

// The record is saved by now, so failures here are logged, not returned.
async function afterSave(env, day, replaced, device) {
  try {
    await env.DB.prepare("DELETE FROM submissions WHERE day < ?").bind(Feedback.shiftDay(day, -KEEP_SUBMISSION_DAYS)).run();
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
  }
  if (!replaced) return;
  try {
    await discardPhoto(env, replaced.photo_key, replaced.photo_bytes, device);
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
  }
}

// Deletes a photo, then gives its bytes back. If the delete fails the object
// may still be in R2, so its bytes stay counted and the key is logged for
// clean-up by hand (docs/r2-security.md).
async function discardPhoto(env, key, bytes, device) {
  try {
    await env.PHOTOS.delete(key);
  } catch (e) {
    log({ event: "photo_orphan", key, error: errorText(e) });
    return;
  }
  await release(env.DB, device, bytes);
}

async function getCalibration(url, env, now) {
  const { results } = await env.DB.prepare(`SELECT ${CALIBRATION_COLUMNS} FROM feedback ORDER BY id`).all();
  const body = { ...Calibration.compute(results), generated_at: now.toISOString() };
  if (url.searchParams.get("metrics") === "1") body.metrics = Calibration.metrics(results);
  return json(body, 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
}
```

`worker/index.mjs` を次の内容で作る。

```js
// Cloudflare Worker entry. The logic lives in handler.mjs so tests can pass
// their own clock; the Worker always uses the real time.
import { handle } from "./handler.mjs";

export default {
  fetch(request, env) {
    return handle(request, env, new Date());
  },
};
```

- [x] **Step 5: テストが通ることを確かめる**

Run: `node --test worker/worker.test.mjs`
Expected: `ℹ tests 44`、`ℹ pass 44`、`ℹ fail 0`
- `node:sqlite` の ExperimentalWarning が出ることがあるが、問題ない。

- [x] **Step 6: wrangler の設定と .gitignore を置く**

`worker/wrangler.toml` を次の内容で作る。`database_id` は Task 9 で入れる。

```toml
name = "surf-check-feedback"
main = "index.mjs"
compatibility_date = "2026-09-01"

[vars]
# 本番はサイトのオリジンだけ。ローカル開発は worker/.dev.vars で上書きする（README 参照）。
ALLOWED_ORIGINS = "https://tk0407.github.io"
# 写真を R2 に置くのは "false"（か "0"）のときだけ。"true" にして deploy すると、
# 記録は受け付けたまま写真だけ置かなくなる。値が無い・読めないときも置かない。
R2_KILL_SWITCH = "false"
# 送信と写真の上限は worker/quota.mjs の DEFAULT_LIMITS の値を使う。変えるときだけ
# 同じ名前でここに書く（例：GLOBAL_STORAGE_LIMIT = "5368709120"）。
# 一覧と緊急時の使い方は docs/r2-security.md。

[[d1_databases]]
binding = "DB"
database_name = "surf-check-feedback"
# database_id: filled in at deploy

[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "surf-check-photos"
```

リポジトリの直下に `.gitignore` を次の内容で作る。

```
worker/.dev.vars
worker/.wrangler/
```

Run: `git check-ignore worker/.dev.vars worker/.wrangler/x`
Expected: 2行とも表示される（どちらも無視される）。

- [x] **Step 7: 全体のテストを流す**

Run: `node --test`
Expected: `ℹ tests 240`、`ℹ fail 0`

- [x] **Step 8: コミットする**

```bash
git add worker/schema.sql worker/d1-sqlite.mjs worker/quota.mjs worker/handler.mjs worker/index.mjs worker/worker.test.mjs worker/wrangler.toml .gitignore
git commit -F - <<'EOF'
feat: add feedback worker with D1, R2 and cost limits

実況フィードバックを受ける Cloudflare Worker を追加した。POST /feedback は
入力チェック・写真の確認（JPEG、既定 1.5MB まで）・同じ組の上書きを行い、
D1 に記録、R2 に写真を保存する。GET /calibration は記録からその都度補正を
計算して返す。

R2 の料金が膨らまないよう、送信の回数（1分・1日、端末・回線・全体）と
写真の量（1日・保存中、端末・全体）の上限を quota.mjs にまとめ、R2 に書く前に
D1 の1つのトランザクションで判定して数える。写真の上限に当たったときと
R2_KILL_SWITCH が "false" 以外のときは、記録だけ保存する。ログは個人情報を
含まない JSON の1行。テストは node:sqlite を D1 の代わりに使う。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: サイトで補正を読み、ランキングと週間予報にかける

**Files:**
- Modify: `app.js`、`index.html`、`style.css`
- 確認用（コミットしない）：`$VERIFY/` の `cdp.mjs`、`common.mjs`、`static.mjs`、`fake-worker.mjs`、`serve.sh`、`scenario-equiv.mjs`

**Interfaces:**
- Consumes:
  - Task 1 の `Calibration.validate`、`Calibration.apply`、`Calibration.summaryLabel`
  - Task 3 の `Forecast.weeklyForecast(..., scorer)`
  - Task 4 の `worker/handler.mjs` の `handle`、`worker/d1-sqlite.mjs` の `createD1`、`worker/schema.sql`。確認用の Worker が使う。
- Produces（Task 6 が使う）:
  - `app.js` の `FEEDBACK_API`（`const`、今は `""`）、`CALIBRATION`（`let`。補正の JSON または `null`）、`calibrationChip(spot)`、`loadCalibration()`
  - `rankSpot` の返り値に `rawData`（補正前の予報）が加わる。
  - 確認用の道具一式が `$VERIFY` にそろう。

**確認用の道具について**

アプリには DOM のテストが無い。そのため、ヘッドレス Chrome を CDP で直接動かして画面を確かめる。道具はリポジトリの外に置き、コミットしない。

- `REPO`：リポジトリの直下（`/Users/tkasai/Projects/surf-check-deploy`）
- `VERIFY`：リポジトリの外の作業用ディレクトリ。Claude Code なら、そのセッションのスクラッチパッドの下の `verify/`。

以下のコマンドは、この2つを export してから実行する。

```bash
export REPO=/Users/tkasai/Projects/surf-check-deploy
export VERIFY=<スクラッチパッド>/verify   # 例: /private/tmp/claude-501/<プロジェクト>/<セッション>/scratchpad/verify
mkdir -p "$VERIFY"
```

`serve.sh start` は次のものを立てる。

| ポート | 中身 | 用途 |
|---|---|---|
| 8001 | 作業ツリーのコピー。`FEEDBACK_API = "http://localhost:8787"` に書き換える | 補正あり |
| 8002 | 作業ツリーのそのままのコピー。`FEEDBACK_API` は空 | 補正を取りに行かない場合 |
| 8003 | `git merge-base HEAD origin/main` の時点のコピー | 「今と同じ」の比較の基準 |
| 8787 | 確認用の Worker | `worker/handler.mjs` を `node:sqlite`（D1 の代わり）と、ディレクトリ（R2 の代わり）で動かす |

- 8000 には触らない。
- 確認用の Worker の DB と写真は、起動のたびに作り直す。
- `IP_SALT` は起動のたびにランダムに作り、どこにも書かない。
- `R2_KILL_SWITCH` は `"false"`、上限は `DEFAULT_LIMITS` のまま。`R2_KILL_SWITCH` と上限の変数（`MAX_UPLOAD_SIZE`、`*_LIMIT`）は、`serve.sh worker-start` の前にシェルの変数として付けると上書きできる（Task 6 の `scenario-limits.mjs` が使う）。

`scenario-equiv.mjs` は、3つの場合それぞれで、8003 と次の4つが一致するかを比べる。

- 比べるもの
  - ランキング（地域 湘南・今日・昼）の順位・点数・値と HTML
  - 共有 URL
  - 週間予報の値と、セルを開いた詳細の HTML
- 比べる場合
  - `plain`：8002
  - `api`：8001。Worker は動いていて、記録は0件。
  - `worker-down`：8001。Worker は止めてある。
- HTML を比べる前に取り除くもの
  - 潮位グラフの svg の中身。描いた時刻で変わるため。
  - 「行ってきた」ボタン（Task 6 以降）

- [x] **Step 1: 確認用の道具を作る**

`$VERIFY/cdp.mjs`：

```js
// Minimal CDP client over Node's global WebSocket (no packages).
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(port = 9333) {
  const profile = new URL(`./chrome-profile-${port}`, import.meta.url).pathname; // throwaway profile
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=375,812", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch (e) { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const logs = [];
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method && listeners.has(msg.method)) listeners.get(msg.method)(msg.params);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push(`EXCEPTION ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      logs.push(`console.${msg.params.type} ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      logs.push(`log ${msg.params.entry.text} ${msg.params.entry.url || ""}`);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" });

  const page = {
    send, logs,
    on(method, fn) { listeners.set(method, fn); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${expr}\n${r.exceptionDetails.exception?.description}`);
      return r.result.value;
    },
    async waitFor(expr, timeout = 20000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.eval(`Boolean(${expr})`)) return;
        await sleep(150);
      }
      throw new Error(`timeout waiting for: ${expr}`);
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await page.waitFor(`document.readyState === "complete"`);
    },
    async click(selector) {
      const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block: "center"}); el.click(); return true; })()`);
      if (!ok) throw new Error(`no element: ${selector}`);
    },
    async screenshot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(r.data, "base64"));
    },
    async setFile(selector, file) {
      const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
      await send("DOM.setFileInputFiles", { nodeId, files: [file] });
    },
    close() { ws.close(); proc.kill(); },
  };
  return page;
}
```

`$VERIFY/common.mjs`：

```js
// Dates in Japan time, so the scenarios run the same at any hour.
export function jstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}
export const panelState = `(() => { const d = document.querySelector("dialog.fb-panel"); return {
  open: d.open, title: d.querySelector(".fb-title").textContent, date: d.querySelector(".fb-date").value,
  slots: [...d.querySelectorAll("[data-slot]")].map((b) => b.dataset.slot + (b.getAttribute("aria-pressed") === "true" ? "*" : "") + (b.disabled ? "(x)" : "")),
  pressed: Object.fromEntries([...d.querySelectorAll("[data-field][aria-pressed=true]")].map((b) => [b.dataset.field, b.textContent])),
  sendDisabled: d.querySelector(".fb-send").disabled, nameRow: Boolean(d.querySelector(".fb-name")),
  suggest: d.querySelector(".fb-suggest").hidden ? null : d.querySelector(".fb-suggest").textContent,
  preview: !d.querySelector(".fb-preview").hidden,
  panelW: [d.scrollWidth, d.clientWidth], docW: [document.documentElement.scrollWidth, innerWidth],
  status: d.querySelector(".fb-status").textContent, tone: d.querySelector(".fb-status").dataset.tone }; })()`;
export const defaultsLoaded = `document.querySelector('[data-field="wave_band"][aria-pressed="true"]')`;
export function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
}
export const pageFits = `document.documentElement.scrollWidth <= innerWidth`;
// Page exceptions fail the run; failed requests (e.g. a stopped worker) are only printed.
export function checkLogs(page) {
  const exceptions = page.logs.filter((l) => l.startsWith("EXCEPTION"));
  check("no page exceptions", exceptions.length === 0, exceptions);
  for (const l of page.logs) if (!l.startsWith("EXCEPTION")) console.log("  (log)", l);
  if (page.logs.some((l) => l.includes("status of 429") && l.includes("open-meteo.com"))) {
    console.log("NOTE Open-Meteo answered 429 (rate limit): FAILs in this run may come from it; wait a minute and rerun");
  }
}
```

`$VERIFY/static.mjs`：

```js
// Static file server for the verification copies: node static.mjs <dir> <port>.
// (python3 -m http.server has a listen backlog of 5, and Chrome's parallel
// script requests then get reset now and then.)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const [root, port] = process.argv.slice(2);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(root, normalize(path === "/" ? "/index.html" : path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
    console.log(req.method, req.url, 200);
  } catch {
    res.writeHead(404).end();
    console.log(req.method, req.url, 404);
  }
}).listen(Number(port), () => console.log(`serving ${root} on ${port}`));
```

`$VERIFY/fake-worker.mjs`：

```js
// Stand-in for `wrangler dev` (verification only, never committed): serves
// $REPO/worker/handler.mjs on :8787 with node:sqlite as D1 and a directory as R2.
// The database and photos are recreated on every start.
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const repo = process.env.REPO;
const { handle } = await import(`${repo}/worker/handler.mjs`);
const { createD1 } = await import(`${repo}/worker/d1-sqlite.mjs`);
const dir = new URL("./", import.meta.url).pathname;
const dbPath = `${dir}feedback.sqlite`;
const photoDir = `${dir}photos/`;
rmSync(dbPath, { force: true });
rmSync(photoDir, { recursive: true, force: true });
mkdirSync(photoDir);
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(readFileSync(`${repo}/worker/schema.sql`, "utf8"));
const env = {
  DB: createD1(sqlite),
  PHOTOS: {
    async put(key, value) { writeFileSync(photoDir + key.replaceAll("/", "_"), new Uint8Array(value)); },
    async delete(key) { rmSync(photoDir + key.replaceAll("/", "_"), { force: true }); },
  },
  ALLOWED_ORIGINS: "http://localhost:8001",
  IP_SALT: randomBytes(16).toString("hex"),
  R2_KILL_SWITCH: "false",
  // R2_KILL_SWITCH and the limits (MAX_UPLOAD_SIZE, *_LIMIT) can be set from
  // the shell, e.g. R2_KILL_SWITCH=true MINUTE_COUNT_LIMIT=1 serve.sh worker-start
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(R2_KILL_SWITCH|MAX_UPLOAD_SIZE|\w+_LIMIT)$/.test(k))),
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  headers.set("CF-Connecting-IP", req.socket.remoteAddress || "");
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(`http://localhost:8787${req.url}`, {
    method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined,
  });
  const response = await handle(request, env, new Date());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(req.method, req.url, response.status);
}).listen(8787, () => console.log("fake worker on 8787"));
```

`$VERIFY/serve.sh`：

```sh
#!/bin/sh
# Serves copies of the site for the browser checks (verification only, never committed).
#   8001: working tree, FEEDBACK_API = http://localhost:8787
#   8002: working tree as is (FEEDBACK_API empty)
#   8003: $BASE_REF (default: where HEAD left origin/main), for the "same as before" comparison
#   8787: fake worker ($VERIFY/fake-worker.mjs)
# Port 8000 is never touched: the owner's own server may be on it.
set -eu
: "${REPO:?set REPO to the repo root}" "${VERIFY:?set VERIFY to this directory}"
BASE_REF="${BASE_REF:-$(git -C "$REPO" merge-base HEAD origin/main)}"
port_up() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_up() { for _ in $(seq 50); do port_up "$1" && return 0; sleep 0.2; done; echo "port $1 did not start" >&2; exit 1; }
stop_port() { pids=$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true); [ -z "$pids" ] || kill $pids; }

case "${1:-}" in
start)
  for p in 8001 8002 8003 8787; do if port_up $p; then echo "port $p is in use" >&2; exit 1; fi; done
  for d in api plain base; do rm -rf "$VERIFY/$d"; mkdir -p "$VERIFY/$d"; done
  rsync -a --exclude .git "$REPO/" "$VERIFY/api/"
  rsync -a --exclude .git "$REPO/" "$VERIFY/plain/"
  git -C "$REPO" archive "$BASE_REF" | tar -x -C "$VERIFY/base"
  sed -i '' 's|^const FEEDBACK_API = "";|const FEEDBACK_API = "http://localhost:8787";|' "$VERIFY/api/app.js"
  grep -q '^const FEEDBACK_API = "http://localhost:8787";' "$VERIFY/api/app.js" ||
    echo "note: no FEEDBACK_API line in app.js yet; 8001 serves the tree as is" >&2
  node "$VERIFY/static.mjs" "$VERIFY/api" 8001 >"$VERIFY/http-8001.log" 2>&1 &
  node "$VERIFY/static.mjs" "$VERIFY/plain" 8002 >"$VERIFY/http-8002.log" 2>&1 &
  node "$VERIFY/static.mjs" "$VERIFY/base" 8003 >"$VERIFY/http-8003.log" 2>&1 &
  REPO="$REPO" node "$VERIFY/fake-worker.mjs" >"$VERIFY/worker.log" 2>&1 &
  for p in 8001 8002 8003 8787; do wait_up $p; done
  echo "serving 8001 8002 8003 8787"
  ;;
worker-stop) stop_port 8787; echo "worker stopped" ;;
worker-start) REPO="$REPO" node "$VERIFY/fake-worker.mjs" >"$VERIFY/worker.log" 2>&1 & wait_up 8787; echo "worker started" ;;
stop) for p in 8001 8002 8003 8787; do stop_port $p; done; echo "stopped" ;;
*) echo "usage: serve.sh start|stop|worker-stop|worker-start" >&2; exit 2 ;;
esac
```

`$VERIFY/scenario-equiv.mjs`：

```js
// Compares the served copies with $BASE_REF on 8003.
//   plain       8002 (FEEDBACK_API empty): byte-identical, no /calibration request
//   api         8001, worker up with an empty database: identical apart from the buttons
//   worker-down 8001, worker stopped: identical apart from the buttons
// usage: node scenario-equiv.mjs plain api   |   node scenario-equiv.mjs worker-down
import { launch } from "./cdp.mjs";
import { jstDate, check, checkLogs } from "./common.mjs";

const cases = process.argv.slice(2);
const PORTS = { plain: 8002, api: 8001, "worker-down": 8001 };
const today = jstDate(0);
const clean = `(html) => html
  .replace(/<svg class="tide-curve"([^>]*)>[\\s\\S]*?<\\/svg>/g, '<svg class="tide-curve"$1></svg>')
  .replace(/<button type="button" class="feedback-open"[^>]*>[^<]*<\\/button>/g, "")`;

async function capture(port, cdpPort) {
  const page = await launch(cdpPort);
  try {
    await page.goto(`http://localhost:${port}/index.html?region=湘南&date=${today}&slot=afternoon`);
    await page.waitFor(`document.querySelector(".ranking-card") || document.querySelector("#results .failed")`, 60000);
    const ranking = await page.eval(`(() => { const clean = ${clean}; return {
      html: clean(document.getElementById("results").innerHTML),
      rows: LAST_RESULTS.map((r) => ({ name: r.spot.name, scores: r.scores, data: r.data })),
      url: location.pathname + location.search,
      buttons: document.querySelectorAll(".feedback-open").length,
      chips: document.querySelectorAll(".chip.calib").length,
      calibrationRequests: performance.getEntriesByType("resource").filter((e) => e.name.split("?")[0].endsWith("/calibration")).length }; })()`);
    await page.goto(`http://localhost:${port}/index.html?region=湘南&mode=weekly`);
    await page.waitFor(`document.querySelector(".wk-cell") || document.querySelector("#weekly .failed")`, 60000);
    await page.eval(`document.querySelector("button.wk-cell").click()`);
    const weekly = await page.eval(`({ html: document.getElementById("weekly").innerHTML,
      rows: WEEKLY_RESULTS.map((r) => ({ name: r.spot.name, days: r.days, best: r.best })) })`);
    checkLogs(page);
    return { ranking, weekly };
  } finally {
    page.close();
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const base = await capture(8003, 9410);
check("base copy rendered a ranking", base.ranking.rows.length > 0, base.ranking.rows.length);
for (const [i, name] of cases.entries()) {
  const got = await capture(PORTS[name], 9411 + i);
  check(`${name}: ranking order, scores and values match`, same(base.ranking.rows, got.ranking.rows));
  check(`${name}: ranking HTML matches (buttons removed)`, base.ranking.html === got.ranking.html);
  check(`${name}: share URL matches`, base.ranking.url === got.ranking.url, [base.ranking.url, got.ranking.url]);
  check(`${name}: weekly values match`, same(base.weekly.rows, got.weekly.rows));
  check(`${name}: weekly HTML matches (detail open)`, base.weekly.html === got.weekly.html);
  check(`${name}: no calibration chip`, got.ranking.chips === 0, got.ranking.chips);
  if (name === "plain") {
    check("plain: no 行ってきた button", got.ranking.buttons === 0, got.ranking.buttons);
    check("plain: no /calibration request", got.ranking.calibrationRequests === 0, got.ranking.calibrationRequests);
  }
  if (name === "api") check("api: one /calibration request", got.ranking.calibrationRequests === 1, got.ranking.calibrationRequests);
  console.log(`  (${name}: ${got.ranking.buttons} buttons)`);
}
```

- [x] **Step 2: 変える前の状態で比較を流し、失敗することを確かめる**

```bash
sh "$VERIFY/serve.sh" start
node "$VERIFY/scenario-equiv.mjs" plain api
```

Expected:
- 表示・点数の比較はすべて `PASS`。
- `FAIL api: one /calibration request 0` が出て、終了コードは 1。補正をまだ取りに行っていないため。
- `serve.sh start` は `note: no FEEDBACK_API line in app.js yet ...` を出す。これは正常。

止めて、2分待つ。

```bash
sh "$VERIFY/serve.sh" stop
sleep 120
```

- [x] **Step 3: `app.js` を変える**

次の9か所を、上から順に置き換える。

**1. 定数と状態（`const WEEK_DAYS = 7;` の下と `let SPOTS = [];` の下）**

置き換える前：
```js
const WEEK_DAYS = 7;

let SPOTS = [];
```
置き換えた後：
```js
const WEEK_DAYS = 7;
// 実況フィードバックの Worker の URL（末尾の / は付けない）。空のあいだは
// 補正を取りに行かず、「行ってきた」ボタンも出さない。
const FEEDBACK_API = "";
const CALIBRATION_TIMEOUT_MS = 2000;

let SPOTS = [];
let CALIBRATION = null;
let calibrationReady = Promise.resolve();
```

**2. 補正の読み込み（`fetchSpotData` の直後）**

置き換える前：
```js
  return { marine: (await m.json()).hourly, forecast: (await f.json()).hourly };
}
```
置き換えた後：
```js
  return { marine: (await m.json()).hourly, forecast: (await f.json()).hourly };
}

// 補正は起動時に取りに行き、最初の検索は最大 2 秒だけ待つ。遅れて届いた補正は
// 次の検索から使う。取れない・形が違うときは補正なし（今と同じ表示）のまま。
function loadCalibration() {
  if (!FEEDBACK_API) return Promise.resolve();
  const load = fetch(`${FEEDBACK_API}/calibration`)
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => { if (Calibration.validate(json)) CALIBRATION = json; })
    .catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, CALIBRATION_TIMEOUT_MS));
  return Promise.race([load, timeout]);
}
```

**3. `rankSpot`：補正前の値を `rawData` として持ち、補正後の `data` と `scores` を使う**

置き換える前：
```js
  const data = Forecast.slotConditions(marine, forecast, slot, date);
  if (!data) throw new Error("予報データなし");
  const scores = Scoring.scoreSpot(data, spot.bearing);
  const tide = Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date);
  const tideTrend = tideTrendLabel(marine, slot, date);
  const tideSeries = daySeries(marine, date);
  return { spot, scores, data, tide, tideTrend, tideSeries };
```
置き換えた後：
```js
  const rawData = Forecast.slotConditions(marine, forecast, slot, date);
  if (!rawData) throw new Error("予報データなし");
  const { data, scores } = Calibration.apply(rawData, spot, CALIBRATION);
  const tide = Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date);
  const tideTrend = tideTrendLabel(marine, slot, date);
  const tideSeries = daySeries(marine, date);
  return { spot, scores, data, rawData, tide, tideTrend, tideSeries };
```

**4. 「実況補正」の表示（`reasonChips` の直後）**

置き換える前：
```js
  return chips.join("");
}
```
置き換えた後：
```js
  return chips.join("");
}

function calibrationChip(spot) {
  const label = Calibration.summaryLabel(spot.name, CALIBRATION);
  return label ? `<span class="chip calib">${escapeHtml(label)}</span>` : "";
}
```

**5. `resultCard` の理由の行**

置き換える前：
```js
    <div class="reason-row">${reasonChips(result)}</div>
```
置き換えた後：
```js
    <div class="reason-row">${reasonChips(result)}${calibrationChip(result.spot)}</div>
```

**6. `weeklySpot`：週間予報にも補正をかける**

置き換える前：
```js
  const days = Forecast.weeklyForecast(marine, forecast, dates, spot.bearing);
```
置き換えた後：
```js
  const days = Forecast.weeklyForecast(marine, forecast, dates, spot.bearing,
    (data) => Calibration.apply(data, spot, CALIBRATION));
```

**7. `weeklyDetail` の理由の行**

置き換える前：
```js
    <div class="reason-row">${reasonChips({ scores })}</div>
```
置き換えた後：
```js
    <div class="reason-row">${reasonChips({ scores })}${calibrationChip(spot)}</div>
```

**8. `check()`：最初の検索の前に補正を待つ（最大2秒）**

置き換える前：
```js
  try {
    if (currentMode() === "weekly") await runWeekly();
```
置き換えた後：
```js
  try {
    await calibrationReady;
    if (currentMode() === "weekly") await runWeekly();
```

**9. 起動時に補正の取得を始める**

置き換える前：
```js
window.addEventListener("DOMContentLoaded", async () => {
  initDate();
```
置き換えた後：
```js
window.addEventListener("DOMContentLoaded", async () => {
  calibrationReady = loadCalibration();
  initDate();
```

- [x] **Step 4: `index.html` を変える**

アセットの `?v=` を上げる。

```bash
sed -i '' 's/?v=20260924/?v=20260925/g' index.html
grep -c '?v=20260925' index.html
```

Expected: `8`。

`app.js` の中の `spots.json?v=20260924` は変えない（`spots.json` は変えていないため）。

続けて、スクリプトを1つ足す。

**1. `calibration.js` を `share.js` の後、`app.js` の前に読み込む**

置き換える前：
```html
  <script src="share.js?v=20260925"></script>
  <script src="app.js?v=20260925"></script>
```
置き換えた後：
```html
  <script src="share.js?v=20260925"></script>
  <script src="calibration.js?v=20260925"></script>
  <script src="app.js?v=20260925"></script>
```

- [x] **Step 5: `style.css` の末尾に足す**

空行を1行あけて、次を足す。

```css
/* 実況フィードバック */
.chip.calib {
  border-color: rgba(18, 69, 89, 0.18);
  background: var(--soft);
  color: var(--deep);
  white-space: normal;
}
```

- [x] **Step 6: テストを流す**

Run: `node --test`
Expected: `ℹ tests 240`、`ℹ fail 0`

- [x] **Step 7: 補正を取りに行かない場合・記録0件の場合に、今と同じであることを確かめる**

```bash
sh "$VERIFY/serve.sh" start
node "$VERIFY/scenario-equiv.mjs" plain api
```

Expected: すべて `PASS`、終了コード 0。
- 特に次の2行が出ること。
  - `PASS plain: no /calibration request`
  - `PASS api: one /calibration request`
- `(api: 0 buttons)` と表示される。

- [x] **Step 8: Worker が止まっているときも、今と同じであることを確かめる**

```bash
sh "$VERIFY/serve.sh" worker-stop
sleep 120
node "$VERIFY/scenario-equiv.mjs" worker-down
sh "$VERIFY/serve.sh" stop
```

Expected:
- すべて `PASS`、終了コード 0。
- `(log) ... ERR_CONNECTION_REFUSED http://localhost:8787/calibration` が出るのは正常。

`NOTE Open-Meteo answered 429` が出て `FAIL` があったときは、Open-Meteo の回数制限による失敗。次の手順でやり直す。

```bash
sh "$VERIFY/serve.sh" stop
sleep 120
sh "$VERIFY/serve.sh" start
# 失敗したシナリオをもう一度流す（worker-down なら先に worker-stop する）
```

- [x] **Step 9: コミットする**

```bash
git add app.js index.html style.css
git commit -F - <<'EOF'
feat: apply feedback calibration to the ranking and weekly views

起動時に Worker の /calibration を読み（最大2秒待つ）、ランキング・週間予報・
共有に補正をかけるようにした。記録のあるポイントには「実況補正」の表示を出す。
FEEDBACK_API が空のあいだは取りに行かない。補正が無い・取れないときの表示と
点数が origin/main と同じであることを、ブラウザで比べて確かめた。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: 「行ってきた」ボタンと入力パネル

**Files:**
- Create: `feedback-panel.js`
- Modify: `app.js`、`index.html`、`style.css`
- 確認用（コミットしない）：`$VERIFY/make-photo.mjs`、`$VERIFY/scenario-send.mjs`、`$VERIFY/scenario-offline.mjs`、`$VERIFY/scenario-limits.mjs`

**Interfaces:**
- Consumes:
  - Task 1 の `Calibration.WAVE_BANDS` / `WIND_SIDES` / `WIND_STRENGTHS` / `adjust`
  - Task 2 の `Feedback.defaultSession`、`dateRange`、`slotStarted`、`initialObserved`、`sessionFromPhoto`、`readExif`、`suggestSpot`、`buildRecord`、`validateRecord`
  - Task 4 の `POST /feedback` の応答
    - `200 {"ok", "id", "updated"}`。写真を置かなかったときは `photo_skipped` が付く。
    - `400 {"error", "errors"}`
    - `413`、`415`
    - `429 {"error", "limit"}`。`limit` が `_minute` で終わるときは1分の上限、それ以外は1日の上限。
  - Task 5 の `FEEDBACK_API`、`CALIBRATION`、`calibrationChip`、`loadCalibration`、`rankSpot` の `rawData`
  - Task 5 で作った `$VERIFY` の道具（`cdp.mjs`、`common.mjs`、`serve.sh`、`fake-worker.mjs`、`scenario-equiv.mjs`）
- Produces: `window.FeedbackPanel = {open(opts), hasSent(spotName, date, slot)}`
  - `opts` は `{api, spot, spots, card: {date, slot, rawData}, calibration, fetchConditions(spot, date, slot) -> Promise<rawData>, onSent()}`。
  - 送信済みの組は `localStorage` に `スポット名|日付|時間帯` の集合で持つ。

`REPO` と `VERIFY` を、Task 5 で道具を置いた場所に合わせて export しておく。

```bash
export REPO=/Users/tkasai/Projects/surf-check-deploy
export VERIFY=<スクラッチパッド>/verify   # Task 5 で cdp.mjs などを置いたディレクトリ
```

**429 のとき**（Step 8〜11 のどれでも）：`NOTE Open-Meteo answered 429` が出て `FAIL` があったら、Open-Meteo の回数制限による失敗。次の手順でやり直す。Worker の DB と Chrome のプロファイルは起動のたびに作り直すので、送信のシナリオも最初からやり直せる。

```bash
sh "$VERIFY/serve.sh" stop
sleep 120
sh "$VERIFY/serve.sh" start
# 失敗したシナリオをもう一度流す（scenario-offline なら先に worker-stop して 2 分待つ）
```

- [ ] **Step 1: 確認用のシナリオを作る**

`$VERIFY/make-photo.mjs`：JPEG に、撮影時刻と GPS 入りのリトルエンディアンの EXIF を差し込む。

```js
// Splices an EXIF APP1 (DateTimeOriginal + GPS, little-endian) into a real JPEG.
import { readFileSync, writeFileSync } from "node:fs";
const [src, out, takenAt, lat, lon] = process.argv.slice(2);
const u16 = (v) => [v & 255, v >> 8];
const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
const entry = (tag, type, count, value) => [...u16(tag), ...u16(type), ...u32(count), ...value];
const ascii = (s) => Array.from(s + "\0", (c) => c.charCodeAt(0));
const inline = (s) => [...ascii(s), 0, 0, 0, 0].slice(0, 4);
const dms = (deg) => { const d = Math.floor(deg); const m = Math.floor((deg - d) * 60); return [d, m, ((deg - d) * 60 - m) * 60]; };
const rationals = (v) => v.flatMap((x) => [...u32(Math.round(x * 100)), ...u32(100)]);
const exifAt = 8 + 2 + 24 + 4;
const gpsAt = exifAt + 2 + 12 + 4 + 20;
const tiff = [0x49, 0x49, ...u16(42), ...u32(8), ...u16(2),
  ...entry(0x8769, 4, 1, u32(exifAt)), ...entry(0x8825, 4, 1, u32(gpsAt)), ...u32(0),
  ...u16(1), ...entry(0x9003, 2, 20, u32(exifAt + 18)), ...u32(0), ...ascii(takenAt),
  ...u16(4), ...entry(1, 2, 2, inline("N")), ...entry(2, 5, 3, u32(gpsAt + 54)),
  ...entry(3, 2, 2, inline("E")), ...entry(4, 5, 3, u32(gpsAt + 78)), ...u32(0),
  ...rationals(dms(Number(lat))), ...rationals(dms(Number(lon)))];
const app1 = [0xff, 0xe1, (tiff.length + 8) >> 8, (tiff.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
const jpeg = readFileSync(src);
writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), Buffer.from(app1), jpeg.subarray(2)]));
```

`$VERIFY/scenario-send.mjs`：Worker は動いていて、記録は0件の状態から始める。流れは次のとおり。

1. 2タップで送る。
2. 写真を付ける。撮影時刻と撮影位置は、昨日の夕方の太東にしてある。
3. ポイントを太東に切り替えて送る。
4. 同じ組で送り直す。
5. 「実況補正」の表示と、375px の幅に収まることを確かめる。

```js
// Worker up, empty database: 2-tap send, photo (EXIF time + GPS), resend, chip.
import { launch } from "./cdp.mjs";
import { jstDate, panelState, defaultsLoaded, pageFits, check, checkLogs } from "./common.mjs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./", import.meta.url).pathname;
const repo = process.env.REPO;
const today = jstDate(0);
const yesterday = jstDate(-1);
const spots = JSON.parse(readFileSync(`${repo}/spots.json`, "utf8"));
const taito = spots.find((s) => s.name === "太東");
execFileSync("sips", ["-s", "format", "jpeg", "-z", "1200", "900", `${repo}/apple-touch-icon.png`, "--out", `${dir}base.jpg`], { stdio: "ignore" });
execFileSync("node", [`${dir}make-photo.mjs`, `${dir}base.jpg`, `${dir}photo.jpg`,
  `${yesterday.replaceAll("-", ":")} 17:30:00`, String(taito.lat), String(taito.lon)]);
const rows = () => new DatabaseSync(`${dir}feedback.sqlite`, { readOnly: true })
  .prepare("SELECT spot, date, slot, name, rating, wave_band, wind_side, wind_strength, photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback ORDER BY id").all();
const rankingUrl = `http://localhost:8001/index.html?region=千葉北&date=${today}&slot=morning`;
const cardIndex = (name) => page.eval(`LAST_RESULTS.findIndex((r) => r.spot.name === ${JSON.stringify(name)})`);
const sendAndWait = async () => {
  await page.click(".fb-send");
  await page.waitFor(`document.querySelector(".fb-status").textContent === "送りました"`);
  await page.waitFor(`!document.querySelector("dialog.fb-panel").open`, 5000);
};

const page = await launch(9401);
try {
  await page.goto(rankingUrl);
  await page.waitFor(`document.querySelectorAll(".feedback-open").length > 0`, 60000);
  const labels = await page.eval(`[...document.querySelectorAll(".feedback-open")].map((b) => b.textContent)`);
  const cards = await page.eval(`document.querySelectorAll(".ranking-card").length`);
  check("every ranking card has a 行ってきた button", labels.length === cards && labels.every((l) => l === "行ってきた"), { labels, cards });
  check("no calibration chip while the database is empty", (await page.eval(`document.querySelectorAll(".chip.calib").length`)) === 0);
  check("ranking fits 375px", await page.eval(pageFits));
  await page.screenshot(`${dir}1-card.png`);

  // 2 taps: rating, then send
  const ichi = await cardIndex("一宮");
  await page.click(`.feedback-open[data-index="${ichi}"]`);
  await page.waitFor(defaultsLoaded);
  const expected = await page.eval(`Feedback.defaultSession({ date: ${JSON.stringify(today)}, slot: "morning" }, new Date())`);
  let s = await page.eval(panelState);
  check("panel opens on the card's session (or the latest begun one)", s.date === expected.date && s.slots.includes(`${expected.slot}*`), { s, expected });
  check("panel defaults wave, wind side and wind strength from the forecast", ["wave_band", "wind_side", "wind_strength"].every((k) => s.pressed[k]), s.pressed);
  check("send stays disabled until a rating is chosen", s.sendDisabled === true);
  check("name row shows before the first send", s.nameRow === true);
  check("panel fits 375px", s.panelW[0] <= s.panelW[1] && s.docW[0] <= s.docW[1], s);
  await page.screenshot(`${dir}2-panel.png`);
  await page.click('[data-field="rating"][data-value="4"]');
  check("choosing a rating enables send", (await page.eval(panelState)).sendDisabled === false);
  await sendAndWait();
  check("card label becomes 送り直す", (await page.eval(`document.querySelector('.feedback-open[data-index="${ichi}"]').textContent`)) === "送り直す");
  let r = rows();
  check("one row saved for 一宮 with rating 4 and no photo",
    r.length === 1 && r[0].spot === "一宮" && r[0].date === expected.date && r[0].slot === expected.slot && r[0].rating === 4 && r[0].photo_key === null, r);

  // photo: EXIF time moves the session, GPS suggests 太東
  await page.click(`.feedback-open[data-index="${ichi}"]`);
  await page.waitFor(defaultsLoaded);
  check("name row is hidden after the first send", (await page.eval(panelState)).nameRow === false);
  await page.setFile(".fb-file", `${dir}photo.jpg`);
  await page.waitFor(`!document.querySelector(".fb-preview").hidden`);
  await page.waitFor(`document.querySelector(".fb-date").value === ${JSON.stringify(yesterday)} && ${defaultsLoaded}`, 30000);
  s = await page.eval(panelState);
  check("photo time moves the session to yesterday evening", s.date === yesterday && s.slots.includes("evening*"), s);
  check("photo location suggests 太東", Boolean(s.suggest && s.suggest.includes("太東")), s.suggest);
  await page.screenshot(`${dir}3-photo.png`);
  await page.click(".fb-switch");
  await page.waitFor(`document.querySelector(".fb-title").textContent.startsWith("太東") && ${defaultsLoaded}`, 30000);
  s = await page.eval(panelState);
  check("switching moves the panel to 太東 and hides the suggestion", s.suggest === null && s.preview === true, s);
  await page.click('[data-field="rating"][data-value="3"]');
  await page.click('[data-field="wind_side"][data-value="on"]');
  await sendAndWait();
  r = rows();
  const t = r[1] || {};
  check("second row saved for 太東 yesterday evening with the photo",
    r.length === 2 && t.spot === "太東" && t.date === yesterday && t.slot === "evening" && t.rating === 3 && t.wind_side === "on" && typeof t.photo_key === "string", r);
  check("photo location and time are recorded",
    Math.abs(t.photo_lat - taito.lat) < 0.001 && Math.abs(t.photo_lon - taito.lon) < 0.001 && t.photo_taken_at === `${yesterday}T17:30`, t);
  const photos = readdirSync(`${dir}photos`).map((f) => readFileSync(`${dir}photos/${f}`));
  check("stored photo is a JPEG without EXIF",
    photos.length === 1 && photos[0][0] === 0xff && photos[0][1] === 0xd8 && !photos[0].includes(Buffer.from("Exif\0\0")), photos.map((p) => p.length));

  // reload without the HTTP cache (the calibration is cached 5 minutes): chips and labels
  await page.send("Network.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(rankingUrl);
  await page.waitFor(`document.querySelectorAll(".feedback-open").length > 0`, 60000);
  const after = await page.eval(`Object.fromEntries(LAST_RESULTS.map((r, i) => [r.spot.name, {
    label: document.querySelector('.feedback-open[data-index="' + i + '"]').textContent,
    chip: document.querySelectorAll(".ranking-card")[i].querySelector(".chip.calib")?.textContent || null }]))`);
  check("sent label survives a reload", after["一宮"].label === "送り直す" && after["太東"].label === "行ってきた", after);
  check("chips appear only on the spots with feedback",
    Object.entries(after).every(([n, v]) => (["一宮", "太東"].includes(n) ? v.chip?.startsWith("実況補正 1件") : v.chip === null)), after);
  await page.eval(`document.querySelectorAll(".ranking-card")[${ichi}].querySelector(".reason-row").scrollIntoView({ block: "center" })`);
  await page.screenshot(`${dir}4-chip.png`);

  // resending the same session replaces the row
  await page.click(`.feedback-open[data-index="${await cardIndex("一宮")}"]`);
  await page.waitFor(defaultsLoaded);
  await page.click('[data-field="rating"][data-value="5"]');
  await sendAndWait();
  r = rows();
  check("resend replaces the 一宮 row instead of adding one", r.length === 2 && r.filter((x) => x.spot === "一宮").length === 1 && r.find((x) => x.spot === "一宮").rating === 5, r);

  // weekly: no button, chip in the day detail
  await page.goto(`http://localhost:8001/index.html?region=千葉北&mode=weekly`);
  await page.waitFor(`document.querySelector(".wk-cell")`, 60000);
  check("weekly view has no 行ってきた button", (await page.eval(`document.querySelectorAll(".feedback-open").length`)) === 0);
  const wi = await page.eval(`WEEKLY_RESULTS.findIndex((r) => r.spot.name === "一宮")`);
  await page.click(`.wk-card[data-index="${wi}"] button.wk-cell`);
  const wchip = await page.eval(`document.querySelector('.wk-card[data-index="${wi}"] .wk-detail .chip.calib')?.textContent || null`);
  check("weekly detail shows the chip", Boolean(wchip && wchip.startsWith("実況補正 1件")), wchip);
  check("weekly fits 375px", await page.eval(pageFits));
  checkLogs(page);
} catch (e) {
  check("scenario ran to the end", false, e.message);
  console.log(page.logs);
  await page.screenshot(`${dir}fail.png`);
} finally {
  page.close();
}
```

`$VERIFY/scenario-offline.mjs`：Worker を止めた状態で確かめる。
- ランキングは出る。
- 送信に失敗しても、入力と写真が残る。

```js
// Worker stopped: the ranking still shows, and a failed send keeps the input.
import { launch } from "./cdp.mjs";
import { jstDate, defaultsLoaded, check, checkLogs } from "./common.mjs";

const dir = new URL("./", import.meta.url).pathname;
const page = await launch(9402);
try {
  await page.goto(`http://localhost:8001/index.html?region=千葉北&date=${jstDate(0)}&slot=morning`);
  await page.waitFor(`document.querySelectorAll(".feedback-open").length > 0`, 60000);
  check("ranking shows without calibration chips", (await page.eval(`document.querySelectorAll(".chip.calib").length`)) === 0);
  const j = await page.eval(`LAST_RESULTS.findIndex((r) => r.spot.name === "東浪見")`);
  await page.click(`.feedback-open[data-index="${j}"]`);
  await page.waitFor(defaultsLoaded);
  await page.click('[data-field="rating"][data-value="2"]');
  await page.setFile(".fb-file", `${dir}base.jpg`);
  await page.waitFor(`!document.querySelector(".fb-preview").hidden`);
  await page.click(".fb-send");
  await page.waitFor(`document.querySelector(".fb-status").dataset.tone === "error"`, 20000);
  const s = await page.eval(`({ status: document.querySelector(".fb-status").textContent,
    open: document.querySelector("dialog.fb-panel").open,
    rating: document.querySelector('[data-field="rating"][aria-pressed="true"]')?.dataset.value,
    photoKept: !document.querySelector(".fb-preview").hidden,
    sendEnabled: !document.querySelector(".fb-send").disabled,
    label: document.querySelector('.feedback-open[data-index="${j}"]').textContent })`);
  check("failed send says so and keeps the panel open", s.status === "送れませんでした。もう一度送ってください" && s.open, s);
  check("failed send keeps the rating and the photo", s.rating === "2" && s.photoKept && s.sendEnabled, s);
  check("card label is unchanged", s.label === "行ってきた", s);
  await page.screenshot(`${dir}5-error.png`);
  checkLogs(page);
} catch (e) {
  check("scenario ran to the end", false, e.message);
  console.log(page.logs);
  await page.screenshot(`${dir}fail.png`);
} finally {
  page.close();
}
```

`$VERIFY/scenario-limits.mjs`：Worker の上限と写真の非常停止が、パネルにどう出るかを確かめる。Worker を自分の設定で2回立て直し（立て直すたびに DB は空になる）、最後に既定の設定で立て直す。
1. `R2_KILL_SWITCH=true`、`MINUTE_COUNT_LIMIT=1`：写真付きで送ると、記録だけ保存され、そのことが出てパネルが開いたままになる。1分以内の2件目は「1分ほど待って」と出る。
2. `DAILY_UPLOAD_COUNT_LIMIT=1`：その日の2件目は「今日はこれ以上送れません」と出る。

```js
// Worker limits as the panel shows them. Restarts the worker twice with its
// own settings (each start empties the database), and once more at the end
// with the defaults. Needs REPO and VERIFY, like serve.sh.
//   1. R2_KILL_SWITCH=true, MINUTE_COUNT_LIMIT=1: a photo send keeps the
//      record without the photo and the panel stays open; the next send
//      within the minute gets the "wait a minute" message.
//   2. DAILY_UPLOAD_COUNT_LIMIT=1: the second send of the day gets the
//      "no more today" message.
import { launch } from "./cdp.mjs";
import { jstDate, panelState, defaultsLoaded, check, checkLogs } from "./common.mjs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url).pathname;
execFileSync("sips", ["-s", "format", "jpeg", "-z", "1200", "900", `${process.env.REPO}/apple-touch-icon.png`, "--out", `${dir}base.jpg`], { stdio: "ignore" });
const MESSAGES = {
  sent: "送りました",
  sentWithoutPhoto: "送りました。写真は今は受け付けていないため、記録だけ保存しました",
  tooFast: "短い間に送りすぎです。1分ほど待ってから送ってください",
  limited: "今日はこれ以上送れません",
};
const restartWorker = (vars) => {
  execFileSync("sh", [`${dir}serve.sh`, "worker-stop"], { stdio: "ignore" });
  execFileSync("sh", [`${dir}serve.sh`, "worker-start"], { stdio: "ignore", env: { ...process.env, ...vars } });
};
const rows = () => new DatabaseSync(`${dir}feedback.sqlite`, { readOnly: true })
  .prepare("SELECT spot, rating, photo_key FROM feedback ORDER BY id").all();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = await launch(9403);
try {
  restartWorker({ R2_KILL_SWITCH: "true", MINUTE_COUNT_LIMIT: "1" });
  await page.goto(`http://localhost:8001/index.html?region=千葉北&date=${jstDate(0)}&slot=morning`);
  await page.waitFor(`document.querySelectorAll(".feedback-open").length > 0`, 60000);
  const cardIndex = (name) => page.eval(`LAST_RESULTS.findIndex((r) => r.spot.name === ${JSON.stringify(name)})`);
  const openAndRate = async (name, rating) => {
    await page.click(`.feedback-open[data-index="${await cardIndex(name)}"]`);
    await page.waitFor(defaultsLoaded);
    await page.click(`[data-field="rating"][data-value="${rating}"]`);
  };
  const sendAndSettle = async () => {
    await page.click(".fb-send");
    await page.waitFor(`["ok", "error"].includes(document.querySelector(".fb-status").dataset.tone)`, 20000);
    return page.eval(panelState);
  };

  // 1a. kill switch: the record is kept, the photo is not, the panel stays open
  await openAndRate("一宮", 4);
  await page.setFile(".fb-file", `${dir}base.jpg`);
  await page.waitFor(`!document.querySelector(".fb-preview").hidden`);
  let s = await sendAndSettle();
  check("photo send under the kill switch says the photo was not kept", s.tone === "ok" && s.status === MESSAGES.sentWithoutPhoto, s);
  await wait(2500);
  check("the panel stays open so the note can be read", (await page.eval(panelState)).open === true);
  let r = rows();
  check("the record is saved without a photo", r.length === 1 && r[0].spot === "一宮" && r[0].rating === 4 && r[0].photo_key === null, r);
  check("nothing is written to the photo store", readdirSync(`${dir}photos`).length === 0, readdirSync(`${dir}photos`));
  await page.screenshot(`${dir}6-no-photo.png`);
  await page.click(".fb-close");

  // 1b. a second send within the minute
  await openAndRate("太東", 3);
  s = await sendAndSettle();
  check("a second send within the minute asks to wait", s.tone === "error" && s.status === MESSAGES.tooFast && s.open, s);
  check("the refused send keeps the rating", s.pressed.rating === "3 ふつう" && s.sendDisabled === false, s);
  check("the refused send saves nothing", rows().length === 1, rows());
  await page.click(".fb-close");

  // 2. the daily count
  restartWorker({ DAILY_UPLOAD_COUNT_LIMIT: "1" });
  await openAndRate("東浪見", 2);
  s = await sendAndSettle();
  check("the first send of the day goes through", s.tone === "ok" && s.status === MESSAGES.sent, s);
  await page.waitFor(`!document.querySelector("dialog.fb-panel").open`, 5000);
  await openAndRate("東浪見", 5);
  s = await sendAndSettle();
  check("the second send of the day says no more today", s.tone === "error" && s.status === MESSAGES.limited && s.open, s);
  check("only the first send is saved", rows().length === 1 && rows()[0].rating === 2, rows());
  await page.screenshot(`${dir}7-limited.png`);
  checkLogs(page);
} catch (e) {
  check("scenario ran to the end", false, e.message);
  console.log(page.logs);
  await page.screenshot(`${dir}fail.png`);
} finally {
  page.close();
  restartWorker({});
}
```

- [ ] **Step 2: 変える前の状態で送信のシナリオを流し、失敗することを確かめる**

```bash
sh "$VERIFY/serve.sh" start
node "$VERIFY/scenario-send.mjs"
sh "$VERIFY/serve.sh" stop
```

Expected: 約60秒後に `Error: timeout waiting for: document.querySelectorAll(".feedback-open").length > 0` で失敗する。終了コードは 0 以外。

このあと2分待つ（`sleep 120`）。

- [ ] **Step 3: `feedback-panel.js` を作る**

```js
// Browser-only feedback panel: the <dialog>, photo resizing and the POST.
// Everything it needs comes in through open(); it reads no app.js globals.
// The rules (defaults, validation, EXIF) live in feedback.js, which is tested.
(function (root) {
  const { Feedback, Calibration, Forecast, Share } = root;
  const escapeHtml = Share.escapeHtml;

  const STORAGE = { device: "surfcheck.device_id", name: "surfcheck.name", sent: "surfcheck.sent" };
  const MAX_SIDE = 1600;
  const MAX_PHOTO_BYTES = 1572864;
  const QUALITIES = [0.8, 0.6];
  const CLOSE_AFTER_MS = 1200;
  const RATINGS = ["ダメ", "イマイチ", "ふつう", "良い", "最高"];
  const MESSAGES = {
    loading: "予報を読み込んでいます…",
    forecastFailed: "予報を取得できませんでした",
    photoFailed: "写真を読み込めませんでした",
    photoTooBig: "写真が大きすぎます",
    rejectedPhoto: "写真を送れませんでした（大きさ・形式）",
    limited: "今日はこれ以上送れません",
    tooFast: "短い間に送りすぎです。1分ほど待ってから送ってください",
    failed: "送れませんでした。もう一度送ってください",
    sending: "送っています…",
    sent: "送りました",
    sentWithoutPhoto: "送りました。写真は今は受け付けていないため、記録だけ保存しました",
  };
  const FIELDS = {
    rating: RATINGS.map((label, i) => [String(i + 1), `${i + 1} ${label}`]),
    wave_band: Calibration.WAVE_BANDS.map((band, i) => [String(i), band.label]),
    wind_side: Object.entries(Calibration.WIND_SIDES),
    wind_strength: Object.entries(Calibration.WIND_STRENGTHS).map(([key, s]) => [key, s.label]),
  };
  const NUMERIC_FIELDS = ["rating", "wave_band"];

  // localStorage can throw (private mode, blocked storage); the panel still
  // works without it, it just forgets between visits.
  function load(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* not persisted */ }
  }

  let sessionDeviceId = null;
  function deviceId() {
    const stored = load(STORAGE.device);
    if (stored) return stored;
    sessionDeviceId = sessionDeviceId || root.crypto.randomUUID();
    save(STORAGE.device, sessionDeviceId);
    return sessionDeviceId;
  }

  function sentList() {
    try {
      const list = JSON.parse(load(STORAGE.sent) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  const sentKey = (spotName, date, slot) => `${spotName}|${date}|${slot}`;
  function hasSent(spotName, date, slot) {
    return sentList().includes(sentKey(spotName, date, slot));
  }
  function markSent(spotName, date, slot) {
    const list = sentList();
    const key = sentKey(spotName, date, slot);
    if (!list.includes(key)) save(STORAGE.sent, JSON.stringify([...list, key]));
  }

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function encodeJpeg(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  // Longest side MAX_SIDE, JPEG at 0.8 then 0.6; null when both stay over
  // MAX_PHOTO_BYTES. Re-encoding through a canvas drops all EXIF, GPS included.
  async function resizePhoto(file) {
    const img = await decodeImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITIES) {
      const blob = await encodeJpeg(canvas, quality);
      if (!blob) throw new Error("encode");
      if (blob.size <= MAX_PHOTO_BYTES) return blob;
    }
    return null;
  }

  async function readJson(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  async function failureMessage(res) {
    if (!res || res.status >= 500) return MESSAGES.failed;
    if (res.status === 413 || res.status === 415) return MESSAGES.rejectedPhoto;
    const body = await readJson(res);
    if (res.status === 429) {
      const perMinute = body && typeof body.limit === "string" && body.limit.endsWith("_minute");
      return perMinute ? MESSAGES.tooFast : MESSAGES.limited;
    }
    if (res.status === 400 && body && typeof body.error === "string") return body.error;
    return MESSAGES.failed;
  }

  function choiceRow(label, field) {
    const buttons = FIELDS[field].map(([value, text]) =>
      `<button type="button" class="fb-choice" data-field="${field}" data-value="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(text)}</button>`).join("");
    return `<div class="fb-row"><span class="fb-label">${label}</span><div class="fb-choices" role="group" aria-label="${label}">${buttons}</div></div>`;
  }

  function panelHtml(showName) {
    const slots = Forecast.SLOT_ORDER.map((slot) =>
      `<button type="button" class="fb-choice" data-slot="${slot}" aria-pressed="false">${Share.SLOT_SHORT[slot]}</button>`).join("");
    const nameRow = showName
      ? `<div class="fb-row"><label class="fb-label" for="fb-name">名前</label><input id="fb-name" class="fb-name" maxlength="20" autocomplete="nickname" placeholder="任意"></div>`
      : "";
    return `<div class="fb-form">
      <div class="fb-head">
        <b class="fb-title"></b>
        <button type="button" class="fb-close" aria-label="閉じる">×</button>
      </div>
      <div class="fb-when">
        <input type="date" class="fb-date" aria-label="日付" required>
        <div class="fb-choices" role="group" aria-label="時間帯">${slots}</div>
      </div>
      <p class="fb-suggest" hidden><span class="fb-suggest-text"></span><button type="button" class="fb-switch"></button></p>
      ${choiceRow("総合", "rating")}
      ${choiceRow("波", "wave_band")}
      ${choiceRow("風向き", "wind_side")}
      ${choiceRow("風の強さ", "wind_strength")}
      <div class="fb-row"><span class="fb-label">写真</span><div class="fb-photo">
        <label class="fb-photo-add">写真を追加<input type="file" accept="image/*" class="fb-file"></label>
        <span class="fb-preview" hidden><img alt="選んだ写真"><button type="button" class="fb-photo-remove">取り消す</button></span>
        <span class="fb-hint">任意</span>
      </div></div>
      ${nameRow}
      <p class="fb-status" role="status" aria-live="polite"></p>
      <button type="button" class="fb-send" disabled>送る</button>
    </div>`;
  }

  let dialog = null;

  // opts: { api, spot, spots, card: { date, slot, rawData }, calibration,
  //         fetchConditions(spot, date, slot) -> Promise<rawData>, onSent() }
  function open(opts) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "fb-panel";
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = panelHtml(sentList().length === 0);
    const $ = (sel) => dialog.querySelector(sel);
    const initial = Feedback.defaultSession(opts.card, new Date());
    const state = {
      spot: opts.spot,
      date: initial.date,
      slot: initial.slot,
      rawData: null,
      observed: { rating: null, wave_band: null, wind_side: null, wind_strength: null },
      photo: null,
      suggestion: null,
      sessionTouched: false,
      loadSeq: 0,
      sending: false,
      done: false,
      closeTimer: null,
    };

    function setStatus(text, tone) {
      const el = $(".fb-status");
      el.textContent = text || "";
      el.dataset.tone = tone || "";
    }

    function syncSession() {
      const now = new Date();
      const { min, max } = Feedback.dateRange(now);
      $(".fb-title").textContent = `${state.spot.name}  ${Share.mdLabel(state.date)}`;
      const dateEl = $(".fb-date");
      dateEl.min = min;
      dateEl.max = max;
      dateEl.value = state.date;
      dialog.querySelectorAll("[data-slot]").forEach((btn) => {
        btn.disabled = !Feedback.slotStarted(state.date, btn.dataset.slot, now);
        btn.setAttribute("aria-pressed", String(btn.dataset.slot === state.slot));
      });
    }

    function syncChoices() {
      dialog.querySelectorAll("[data-field]").forEach((btn) => {
        const field = btn.dataset.field;
        btn.setAttribute("aria-pressed", String(String(state.observed[field]) === btn.dataset.value));
        btn.disabled = field !== "rating" && !state.rawData;
      });
      $(".fb-send").disabled = state.sending || state.done || !state.rawData || state.observed.rating === null;
    }

    function syncPhoto() {
      const preview = $(".fb-preview");
      preview.hidden = !state.photo;
      $(".fb-photo-add").hidden = Boolean(state.photo);
      if (state.photo) preview.querySelector("img").src = state.photo.url;
      const row = $(".fb-suggest");
      row.hidden = !state.suggestion;
      if (state.suggestion) {
        const { spot, km } = state.suggestion;
        $(".fb-suggest-text").textContent = `写真は ${spot.name} 付近（約 ${km.toFixed(1)}km）で撮られています`;
        $(".fb-switch").textContent = `${spot.name}に変える`;
      }
    }

    async function loadForecast() {
      const seq = ++state.loadSeq;
      state.rawData = null;
      Object.assign(state.observed, { wave_band: null, wind_side: null, wind_strength: null });
      syncSession();
      syncChoices();
      const card = opts.card;
      let raw = null;
      if (card.rawData && state.spot === opts.spot && state.date === card.date && state.slot === card.slot) {
        raw = card.rawData;
      } else {
        setStatus(MESSAGES.loading);
        try {
          raw = await opts.fetchConditions(state.spot, state.date, state.slot);
        } catch (e) {
          raw = null;
        }
        if (seq !== state.loadSeq) return; // a newer date, slot or spot took over
      }
      if (!raw) {
        setStatus(MESSAGES.forecastFailed, "error");
        syncChoices();
        return;
      }
      state.rawData = raw;
      // Defaults come from what the card showed (calibrated); the record keeps raw.
      const shown = Calibration.adjust(raw, state.spot.name, opts.calibration);
      Object.assign(state.observed, Feedback.initialObserved(shown, state.spot.bearing));
      if ($(".fb-status").textContent === MESSAGES.loading) setStatus("");
      syncChoices();
    }

    function changeSession(date, slot, byHand) {
      if (byHand) state.sessionTouched = true;
      const next = Feedback.defaultSession({ date, slot }, new Date());
      if (next.date === state.date && next.slot === state.slot) {
        syncSession();
        return;
      }
      state.date = next.date;
      state.slot = next.slot;
      loadForecast();
    }

    function clearPhoto() {
      if (state.photo) URL.revokeObjectURL(state.photo.url);
      state.photo = null;
      state.suggestion = null;
      $(".fb-file").value = "";
      syncPhoto();
    }

    async function onPhoto(file) {
      clearPhoto();
      if (!file) return;
      if ($(".fb-status").dataset.tone === "error") setStatus("");
      let meta = null;
      try {
        meta = Feedback.readExif(await file.arrayBuffer());
      } catch (e) {
        meta = null;
      }
      let blob;
      try {
        blob = await resizePhoto(file);
      } catch (e) {
        setStatus(MESSAGES.photoFailed, "error");
        return;
      }
      if (!blob) {
        setStatus(MESSAGES.photoTooBig, "error");
        return;
      }
      state.photo = { blob, url: URL.createObjectURL(blob), meta };
      state.suggestion = Feedback.suggestSpot(meta, state.spot, opts.spots);
      syncPhoto();
      if (meta && meta.taken_at && !state.sessionTouched) {
        const session = Feedback.sessionFromPhoto(meta.taken_at, new Date());
        if (session) changeSession(session.date, session.slot, false);
      }
    }

    function switchSpot() {
      if (!state.suggestion) return;
      state.spot = state.suggestion.spot;
      state.suggestion = null;
      syncPhoto();
      loadForecast();
    }

    async function send() {
      if (state.sending || state.done || !state.rawData || state.observed.rating === null) return;
      const nameEl = $(".fb-name");
      const record = Feedback.buildRecord({
        deviceId: deviceId(),
        name: nameEl ? nameEl.value : load(STORAGE.name) || "",
        spot: state.spot,
        date: state.date,
        slot: state.slot,
        rawData: state.rawData,
        observed: state.observed,
        photoMeta: state.photo ? state.photo.meta : null,
      });
      const errors = Feedback.validateRecord(record, new Date());
      if (errors.length) {
        setStatus(errors.join(" / "), "error");
        return;
      }
      const body = new FormData();
      body.append("record", JSON.stringify(record));
      if (state.photo) body.append("photo", state.photo.blob, "photo.jpg");
      state.sending = true;
      syncChoices();
      setStatus(MESSAGES.sending);
      let res = null;
      try {
        res = await fetch(`${opts.api}/feedback`, { method: "POST", body });
      } catch (e) {
        res = null;
      }
      state.sending = false;
      if (res && res.ok) {
        // The Worker keeps the record but may skip the photo (limits, kill switch).
        const photoSkipped = Boolean((await readJson(res) || {}).photo_skipped);
        state.done = true;
        markSent(record.spot, record.date, record.slot);
        if (nameEl) save(STORAGE.name, record.name);
        setStatus(photoSkipped ? MESSAGES.sentWithoutPhoto : MESSAGES.sent, "ok");
        syncChoices();
        if (opts.onSent) opts.onSent();
        // Leave that note up until the user closes the panel.
        if (!photoSkipped) state.closeTimer = setTimeout(() => dialog.close(), CLOSE_AFTER_MS);
        return;
      }
      setStatus(await failureMessage(res), "error");
      syncChoices();
    }

    // Handlers are assigned (not added) so each open replaces the last one's.
    dialog.onclick = (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;
      if (btn.classList.contains("fb-close")) dialog.close();
      else if (btn.dataset.slot) changeSession(state.date, btn.dataset.slot, true);
      else if (btn.dataset.field) {
        const field = btn.dataset.field;
        state.observed[field] = NUMERIC_FIELDS.includes(field) ? Number(btn.dataset.value) : btn.dataset.value;
        syncChoices();
      } else if (btn.classList.contains("fb-photo-remove")) clearPhoto();
      else if (btn.classList.contains("fb-switch")) switchSpot();
      else if (btn.classList.contains("fb-send")) send();
    };
    dialog.onchange = (e) => {
      if (e.target.classList.contains("fb-date")) {
        if (e.target.value) changeSession(e.target.value, state.slot, true);
        else syncSession();
      } else if (e.target.classList.contains("fb-file")) {
        onPhoto(e.target.files[0]);
      }
    };
    dialog.onclose = () => {
      clearTimeout(state.closeTimer);
      state.loadSeq += 1;
      if (state.photo) URL.revokeObjectURL(state.photo.url);
    };

    syncPhoto();
    loadForecast();
    dialog.showModal();
  }

  root.FeedbackPanel = { open, hasSent };
})(self);
```

- [ ] **Step 4: `app.js` を変える**

次の9か所を、上から順に置き換える。

**1. パネル用の予報の取得（`loadCalibration` の直後）**

置き換える前：
```js
  return Promise.race([load, timeout]);
}
```
置き換えた後：
```js
  return Promise.race([load, timeout]);
}

// 入力パネル用：その日・時間帯の補正前の予報値。
async function fetchConditions(spot, date, slot) {
  const { marine, forecast } = await fetchSpotData(spot.lat, spot.lon, date, date);
  const data = Forecast.slotConditions(marine, forecast, slot, date);
  if (!data) throw new Error("予報データなし");
  return data;
}
```

**2. ボタンのラベルと HTML（`calibrationChip` の直後）**

置き換える前：
```js
  return label ? `<span class="chip calib">${escapeHtml(label)}</span>` : "";
}
```
置き換えた後：
```js
  return label ? `<span class="chip calib">${escapeHtml(label)}</span>` : "";
}

// session はパネルが最初に開く日・時間帯（Feedback.defaultSession）。null ならボタンを出さない。
function feedbackLabel(spot, session) {
  return FeedbackPanel.hasSent(spot.name, session.date, session.slot) ? "送り直す" : "行ってきた";
}

function feedbackButton(result, index, session) {
  if (!session) return "";
  return `<button type="button" class="feedback-open" data-index="${index}">${feedbackLabel(result.spot, session)}</button>`;
}
```

**3. `resultCard` の引数に `session` を足す**

置き換える前：
```js
function resultCard(result, index) {
```
置き換えた後：
```js
function resultCard(result, index, session) {
```

**4. ボタンはライブカメラの行の直後に、同じ行でつなげる（ボタンが無いときの HTML を今と同じにするため）**

置き換える前：
```js
    ${Share.camRow(result.spot)}
  </article>`;
```
置き換えた後：
```js
    ${Share.camRow(result.spot)}${feedbackButton(result, index, session)}
  </article>`;
```

**5. 描画した回の、パネルの初期の日付・時間帯を覚えておく**

置き換える前：
```js
let LAST_RANKING_RENDER = null;
```
置き換えた後：
```js
let LAST_RANKING_RENDER = null;
let LAST_FEEDBACK_SESSION = null;
```

**6. `renderResults`：`FEEDBACK_API` があるときだけ session を決める**

置き換える前：
```js
  LAST_RANKING_RENDER = { el, date, slot };
```
置き換えた後：
```js
  LAST_RANKING_RENDER = { el, date, slot };
  LAST_FEEDBACK_SESSION = FEEDBACK_API ? Feedback.defaultSession({ date, slot }, new Date()) : null;
```

**7. `renderResults`：カードに session を渡す**

置き換える前：
```js
      ${results.map(resultCard).join("")}
```
置き換えた後：
```js
      ${results.map((r, i) => resultCard(r, i, LAST_FEEDBACK_SESSION)).join("")}
```

**8. ボタンの押下とラベルの更新（`settleBySpot` の説明コメントの直前）**

置き換える前：
```js
// Runs fn for every spot in parallel; spots whose promise rejects are
```
置き換えた後：
```js
function refreshFeedbackButtons() {
  if (!LAST_RANKING_RENDER || !LAST_FEEDBACK_SESSION) return;
  LAST_RANKING_RENDER.el.querySelectorAll(".feedback-open").forEach((btn) => {
    const result = LAST_RESULTS[Number(btn.dataset.index)];
    if (result) btn.textContent = feedbackLabel(result.spot, LAST_FEEDBACK_SESSION);
  });
}

function onFeedbackClick(e) {
  const btn = e.target.closest(".feedback-open");
  if (!btn || !LAST_RANKING_RENDER) return;
  const result = LAST_RESULTS[Number(btn.dataset.index)];
  if (!result) return;
  const { date, slot } = LAST_RANKING_RENDER;
  FeedbackPanel.open({
    api: FEEDBACK_API,
    spot: result.spot,
    spots: SPOTS,
    card: { date, slot, rawData: result.rawData },
    calibration: CALIBRATION,
    fetchConditions,
    onSent: refreshFeedbackButtons,
  });
}

// Runs fn for every spot in parallel; spots whose promise rejects are
```

**9. クリックを結果の欄でまとめて受ける**

置き換える前：
```js
  resultsEl.addEventListener("pointerleave", hideTideHover);
```
置き換えた後：
```js
  resultsEl.addEventListener("pointerleave", hideTideHover);
  resultsEl.addEventListener("click", onFeedbackClick);
```

- [ ] **Step 5: `index.html` にスクリプトを2つ足す**

**1. `feedback.js` と `feedback-panel.js` を `calibration.js` の後に読み込む**

置き換える前：
```html
  <script src="calibration.js?v=20260925"></script>
  <script src="app.js?v=20260925"></script>
```
置き換えた後：
```html
  <script src="calibration.js?v=20260925"></script>
  <script src="feedback.js?v=20260925"></script>
  <script src="feedback-panel.js?v=20260925"></script>
  <script src="app.js?v=20260925"></script>
```

- [ ] **Step 6: `style.css` の末尾に足す**

Task 5 で足した `.chip.calib` の後ろに、空行を1行あけて足す。

```css
.feedback-open {
  width: 100%;
  min-height: 40px;
  margin-top: 10px;
  border: 1px solid var(--sea);
  border-radius: 8px;
  background: var(--panel);
  color: var(--sea);
  font: inherit;
  font-size: 0.88rem;
  font-weight: 800;
  cursor: pointer;
}

.fb-panel {
  width: min(560px, 100%);
  max-width: 100%;
  max-height: 92vh;
  margin: auto auto 0;
  padding: 0;
  border: 0;
  border-radius: 14px 14px 0 0;
  background: var(--panel);
  color: var(--ink);
  overflow-x: hidden;
  overflow-y: auto;
  box-shadow: var(--shadow);
}

.fb-panel::backdrop {
  background: rgba(18, 69, 89, 0.35);
}

.fb-form {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.fb-head,
.fb-when,
.fb-row {
  display: grid;
  grid-template-columns: 4.5em minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.fb-head {
  grid-template-columns: minmax(0, 1fr) auto;
}

.fb-title {
  color: var(--deep);
  font-size: 1rem;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fb-close {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 999px;
  background: var(--soft);
  color: var(--deep);
  font: inherit;
  font-size: 1.2rem;
  cursor: pointer;
}

.fb-when {
  grid-template-columns: minmax(0, 1fr) auto;
}

.fb-label {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 800;
}

.fb-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.fb-choice {
  min-height: 34px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 750;
  cursor: pointer;
}

.fb-choice[aria-pressed="true"] {
  border-color: var(--sea);
  background: var(--sea);
  color: #fff;
}

.fb-choice:disabled {
  opacity: 0.4;
  cursor: default;
}

.fb-date,
.fb-name {
  width: 100%;
  min-width: 0;
  height: 39px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 16px;
}

.fb-photo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.fb-photo-add {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 4px 12px;
  border: 1px dashed var(--sea);
  border-radius: 8px;
  color: var(--sea);
  font-size: 0.82rem;
  font-weight: 800;
  cursor: pointer;
}

.fb-photo-add input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.fb-photo-add[hidden],
.fb-preview[hidden],
.fb-suggest[hidden] {
  display: none;
}

.fb-preview {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.fb-preview img {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  object-fit: cover;
}

.fb-photo-remove,
.fb-switch {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  color: var(--deep);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 800;
  cursor: pointer;
}

.fb-hint {
  color: var(--muted);
  font-size: 0.76rem;
}

.fb-suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(244, 201, 107, 0.24);
  font-size: 0.82rem;
}

.fb-status {
  min-height: 1.2em;
  margin: 0;
  color: var(--muted);
  font-size: 0.84rem;
}

.fb-status[data-tone="error"] {
  color: #b84a3c;
}

.fb-status[data-tone="ok"] {
  color: var(--good);
  font-weight: 800;
}

.fb-send {
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: var(--sea);
  color: #fff;
  font: inherit;
  font-size: 0.95rem;
  font-weight: 850;
  cursor: pointer;
}

.fb-send:disabled {
  opacity: 0.45;
  cursor: default;
}
```

- [ ] **Step 7: テストを流す**

Run: `node --test`
Expected: `ℹ tests 240`、`ℹ fail 0`

- [ ] **Step 8: 送信のシナリオを流す**

```bash
sh "$VERIFY/serve.sh" start
node "$VERIFY/scenario-send.mjs"
```

Expected: すべて `PASS`、終了コード 0。主な確認項目は次のとおり。
- 全カードに「行ってきた」が出て、375px の幅に収まる。
- パネルの初期値
  - 波・風向き・風の強さの初期値が入る。
  - 総合を選ぶまで「送る」を押せない。
  - 名前の行が出る。
- 総合 4 → 送る（2タップ）
  - 「送りました」と出てパネルが閉じる。
  - ラベルが「送り直す」になる。
  - D1 に1行できる。
- 2回目にパネルを開いたとき、名前の行は出ない。
- 写真を付けたとき
  - 日付・時間帯が昨日の夕方に変わる。
  - 太東への切り替えの提案が出る。
- 太東に切り替えて送ったとき
  - 2行目ができ、写真の位置と時刻が入る。
  - R2 の写真は JPEG で、EXIF（`Exif\0\0`）が残っていない。
- キャッシュを切って読み直したとき
  - ラベルが残る。
  - 「実況補正 1件」が一宮と太東にだけ出る。
- 同じ組で送り直すと、行が増えずに上書きされる。
- 週間予報
  - ボタンは出ない。
  - 詳細に「実況補正」が出る。
  - 375px の幅に収まる。

`$VERIFY/1-card.png`〜`4-chip.png` を開いて、見た目が崩れていないことを目で確かめる。

- [ ] **Step 9: Worker が止まっているときのシナリオを流す**

```bash
sh "$VERIFY/serve.sh" worker-stop
sleep 120
node "$VERIFY/scenario-offline.mjs"
```

Expected: すべて `PASS`。
- ランキングは出て、「実況補正」の表示は無い。
- 送ると「送れませんでした。もう一度送ってください」が error の色で出る。
- パネルは開いたまま。総合と写真が残り、「送る」をもう一度押せる。
- ボタンのラベルは変わらない。

`$VERIFY/5-error.png` を目で確かめる。

- [ ] **Step 10: 上限と写真の非常停止のシナリオを流す**

Step 8 で立てた 8001〜8003 は動いたまま。Worker はシナリオが自分で立て直す。

```bash
sleep 120
node "$VERIFY/scenario-limits.mjs"
```

Expected: 11 件すべて `PASS`、終了コード 0。
- 写真付きで送ると「送りました。写真は今は受け付けていないため、記録だけ保存しました」が ok の色で出る。2.5秒たってもパネルは開いたまま。
- 記録は1行で、`photo_key` は空。写真の置き場に何も無い。
- 1分以内の2件目は「短い間に送りすぎです。1分ほど待ってから送ってください」が error の色で出る。総合は残り、「送る」をもう一度押せる。何も保存されない。
- 1日1件にした Worker では、1件目は通り、2件目は「今日はこれ以上送れません」と出て、保存されない。

`$VERIFY/6-no-photo.png` と `$VERIFY/7-limited.png` を目で確かめる。

- [ ] **Step 11: ボタンを足したあとも、今と同じであることを確かめる**

```bash
sh "$VERIFY/serve.sh" stop
sleep 120
sh "$VERIFY/serve.sh" start
node "$VERIFY/scenario-equiv.mjs" plain api
sh "$VERIFY/serve.sh" stop
```

Expected: すべて `PASS`。
- `PASS plain: no 行ってきた button` が出る。
- `(api: N buttons)` の N は、ランキングのカードの数と同じ。
- 比べる HTML からはボタンを取り除いているので、それ以外は1バイトも違わない。

`NOTE Open-Meteo answered 429` が出て `FAIL` があったときは、このタスクの最初にある「429 のとき」の手順でやり直す。

- [ ] **Step 12: コミットする**

```bash
git add feedback-panel.js app.js index.html style.css
git commit -F - <<'EOF'
feat: add the session feedback panel to ranking cards

ランキングの各カードに「行ってきた」ボタンを置き、下から出る入力パネルで
総合・波・風向き・風の強さ・写真を送れるようにした。波と風の初期値は
カードの予報なので、最短2タップで送れる。写真の撮影時刻で日付・時間帯を
合わせ、撮影位置が離れていれば近いポイントを提案する。送った組は端末に
覚えて「送り直す」と表示する。FEEDBACK_API が空のあいだはボタンを出さない。
Worker が写真を置かなかったときはそのことを出してパネルを開いたままにし、
送りすぎで断られたときは、1分の上限と1日の上限で違う文を出す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: README と R2 の文書

**Files:**
- Modify: `README.md`
- Create: `docs/r2-security.md`

**Interfaces:**
- Consumes: Task 1〜6 のファイル名と振る舞い、Task 4 の `wrangler.toml` の名前（`surf-check-feedback`、`surf-check-photos`）、`worker/quota.mjs` の `DEFAULT_LIMITS`、`worker/handler.mjs` のログの `event`
- Produces:
  - 記録の消し方・ポイント名の書き換え方の手順。Task 9 の公開で使う。
  - `docs/r2-security.md`：管理画面での設定（Task 9 の Step 1・2 で使う）、見張り方と数のずれの直し方（Task 9 の Step 7）、緊急時の手順（公開後にユーザーへ渡す）。読む人はサイトの持ち主（運用する人）。

- [ ] **Step 1: README を書き換える**

`README.md` を次の内容にする。今の README に次を足したもの。
- 冒頭の説明の「サーバー・APIキー不要」を書き換える。
- 構成に新しいファイルと `worker/` を足す。
- 次の節を足す。
  - 「実況フィードバックと補正」
  - 「ローカルで動かす」の Worker の部分
  - 「フィードバック用 Worker の公開」
  - 「記録の消し方」
  - 「ポイント名を変えたとき」

````markdown
# 🏄 サーフチェック (Web)

エリア・日付・時間帯を選ぶと、関東のサーフポイントを波質スコアでランキング表示する静的Webアプリ。
「週間予報」タブでは、エリア内の各ポイントの7日分のスコアを朝・昼・夕で一覧でき、セルをタップすると詳細を表示する。
予報データは [Open-Meteo](https://open-meteo.com)（Marine + Forecast API）をブラウザから直接取得する（APIキー不要）。
実際に行った人の実況フィードバックの受け付けと補正の計算だけ、Cloudflare Worker（`worker/`）を使う。Worker が無くてもサイトは今までどおり動く。

公開: GitHub Pages（Settings → Pages → Deploy from a branch / `main` / root）。

## 構成

```
index.html        UI
style.css
scoring.js        採点ロジック
forecast.js       時間帯平均・週間予報の組み立て（ランキングと共用）
share.js          表示ラベルの整形、共有テキスト・共有カード・共有URLの組み立て
calibration.js    実況フィードバックからの補正の計算と、予報・採点へのかけ方（サイトと Worker で共用）
feedback.js       入力パネルの初期値、記録の組み立てと入力チェック、写真の EXIF 読み取り（サイトと Worker で共用）
feedback-panel.js 入力パネルの描画と操作、写真の縮小、送信（ブラウザ専用）
app.js            取得→描画、タブ切替
spots.json        スポットデータ
scoring.test.js   テスト（採点）
forecast.test.js  テスト（時間帯平均・週間予報）
share.test.js     テスト（共有テキスト・共有URL・復元）
spots.test.js     テスト（spots.json の形とライブカメラのURL）
calibration.test.js  テスト（補正の計算・かけ方・検証値）
feedback.test.js  テスト（初期値・入力チェック・EXIF・近いポイント）

worker/
  index.mjs       Worker の入口（handler.mjs に今の時刻を渡すだけ）
  handler.mjs     POST /feedback と GET /calibration、CORS、写真の保存と片付け
  quota.mjs       送信の回数・写真の大きさと容量の上限、写真の非常停止（D1 で数える）
  schema.sql      D1 のテーブル定義
  wrangler.toml   Worker 名、D1・R2 の紐づけ、ALLOWED_ORIGINS、R2_KILL_SWITCH
  d1-sqlite.mjs   テスト専用。Node 内蔵の node:sqlite を D1 と同じ呼び方で使う
  worker.test.mjs テスト（Worker）

docs/
  r2-security.md  写真（R2）のコスト対策、上限の変え方、管理画面での設定、緊急時の手順
```

## 共有機能

ランキング結果の下に「LINEで送る」「画像で共有」の2つのボタンがある。LINEで送ると、上位3件のポイント名・点数・波と風を短いテキストにまとめ、結果を再現できるURL（`?region=&date=&slot=`）を添えてLINEのトーク選択画面を開く。「画像で共有」は同じ上位3件を1080×1080のカード画像としてcanvasに描画し、対応する端末では共有シートから、それ以外ではダウンロードで保存できる。共有URLを開くとエリア・日付・時間帯が自動で入り、そのままチェックが実行されて同じランキングが再現される。

「週間予報」タブにも同じ「LINEで送る」「画像で共有」が付いている。共有されるのは各日のベスト（ポイント・時間帯・点数）の7行で、週で最も点数が高い日には★が付く。共有URLは `?region=...&mode=weekly` で、開くと週間予報タブが選ばれた状態でエリアが入る。ただし週間の共有URLには日付を入れていないため、表示される7日分は常に「開いた日から」になる。共有した翌日以降に開くと、エリアとタブは再現されるが期間はずれる。`mode` の付かないランキングの共有URLは日付・時間帯を含むので、従来どおり同じ内容が再現される。

## ライブカメラ

検索結果のカードの一番下に「ライブカメラ」の行が出る。リンクは別タブで開く（埋め込み再生はしない）。出典は `spots.json` の `cams` に持たせてあり、1ポイントあたり最大2本。並びは優先度順（YouTube → Surfers Ocean → BCM）で、先頭から2本を出す。カメラが無いポイント、名前の一致する生きたカメラが見つからなかったポイントでは行ごと出さない（32ポイント中26ポイントに行が出る）。

```json
{ "name": "部原", "cams": [{ "label": "YouTube サンセット", "url": "https://..." }] }
```

リンク先は YouTube のライブ配信、Surfers Ocean のポイント別ページ、BCM SurfPatrol の `wave-detail` ページの3種類。いずれも無料で見られる。`spots.test.js` がホスト・本数・https・エリアをまたぐ使い回しをテストで止めている。ライブ配信は止まることがあるので、リンク切れに気づいたら `spots.json` を直す。

## 実況フィードバックと補正

ランキングの各カードの一番下に「行ってきた」ボタンがある。押すと入力パネルが下から開き、その回の総合評価（1〜5）・波のサイズ・風向き（オフ／サイド／オン）・風の強さ・写真1枚（任意）を送れる。波・風の初期値はカードに出ていた予報なので、予報どおりだったなら総合を選んで「送る」の2タップで済む。潮は入力も記録もしない。

- 同じ端末・ポイント・日付・時間帯で送り直すと上書きになる（ボタンのラベルが「送り直す」に変わる）。
- 写真は長辺1600pxの JPEG に縮めてから送り、EXIF は残さない。元の写真から撮影時刻が読めれば日付と時間帯を合わせ、撮影位置が選んだポイントから1.0kmを超えて離れていて、ほかのポイントの方が近ければ、そちらに切り替える提案を出す。iPhone の Safari などは位置情報を消してから渡すことが多いので、読めたら使う扱い。
- 送信は1端末・1回線ごとに1分5件まで、1日は1端末20件・1回線30件・全体100件まで。写真は1枚1.5MBまで。写真の容量の上限（1日・合計）に当たったときと、写真の非常停止中は、記録だけ保存して写真は置かない。数と変え方は [docs/r2-security.md](docs/r2-security.md)。

貯まった記録（予報と実況の組）から、Worker の `GET /calibration` がその都度次の補正を計算する。

- ポイントごとの波サイズの倍率（0.5〜2倍）と風速のずれ（±4m/s）。件数が少ないうちは「補正なし」側へ強く寄せる。
- ランキングの配点（風向き・風速・うねりの向き・周期・波高、合計85点）。15件貯まるまでは今の配点のまま。

サイトは起動時に補正を読み（最大2秒待つ）、ランキング・週間予報・共有テキストと共有画像にかける。記録のあるポイントのカードには「実況補正 7件（波×1.2・風+0.6m/s）」のように出る。補正が読めないとき、記録が0件のときは、表示も点数も補正なしと同じ。補正の計算には必ず補正前の予報を使う。`scoring.js` は変えていない。

補正の効果は `GET /calibration?metrics=1` で見られる（記録を1件ずつ抜いて残りで予測する leave-one-out）。`wave_band_mae` の `calibrated` が `raw` より小さく、`rating_concordance` の `calibrated` が `default` より大きければ、補正が効いている。

`app.js` の `FEEDBACK_API` が空文字のときは補正を取りに行かず、「行ってきた」ボタンも出さない。記録や写真を見る画面は無い。写真は Cloudflare の管理画面（R2）で見る。

## ローカルで動かす

```bash
python -m http.server 8000
# http://localhost:8000/
```

フィードバックまで試すときは、Worker もローカルで立てる（ローカルの D1 と R2 を使う）。

```bash
cd worker
# 開発用の設定。.gitignore 済み。IP_SALT はその場で作った使い捨ての値にする
printf 'ALLOWED_ORIGINS=http://localhost:8000\nIP_SALT=%s\n' "$(openssl rand -hex 16)" > .dev.vars
npx wrangler@4 d1 execute surf-check-feedback --local --file schema.sql
npx wrangler@4 dev
# http://localhost:8787/calibration?metrics=1
```

`app.js` の `FEEDBACK_API` を一時的に `"http://localhost:8787"` にして試す（この変更はコミットしない）。送った記録と写真は次で確かめられる。

```bash
npx wrangler@4 d1 execute surf-check-feedback --local --command "SELECT id, spot, date, slot, rating, wave_band, photo_key FROM feedback"
npx wrangler@4 r2 object get surf-check-photos/<photo_key> --local --file /tmp/photo.jpg
```

## テスト

```bash
node --test
```

`fail 0` で全件成功すること。件数はテストを足すたびに変わるので、ここには書かない。

## フィードバック用 Worker の公開

Cloudflare のアカウントと `npx wrangler@4 login` が済んでいる前提。コマンドは `worker/` で実行する。

1. `npx wrangler@4 d1 create surf-check-feedback` を実行し、出力された `database_id` を `wrangler.toml` に書く。
2. `npx wrangler@4 r2 bucket create surf-check-photos`
3. `npx wrangler@4 d1 execute surf-check-feedback --remote --file schema.sql`
4. `openssl rand -hex 32 | npx wrangler@4 secret put IP_SALT`。値は画面にもファイルにも出さずに渡す（回線ごとの回数制限に使う IP のハッシュの塩）。
5. `npx wrangler@4 deploy`
6. 表示された URL（`https://surf-check-feedback.<アカウント>.workers.dev`）を `app.js` の `FEEDBACK_API` に入れ、`index.html` の `?v=` を上げて GitHub Pages に出す。

`ALLOWED_ORIGINS`（`wrangler.toml`）はサイトのオリジンだけにしてある。サイトのドメインを変えたら、ここも直して `deploy` し直す。

公開したら、[docs/r2-security.md](docs/r2-security.md) の「管理画面での設定」にそって、R2 のバケットが非公開のままか（r2.dev が無効で、ドメインが付いていない）を確かめ、予算アラートを作る。写真を止める・受け付けを止めるときの手順も同じ文書にある。

### 記録の消し方

頼まれて消すときは、先に写真の名前を控えてから消す。`<端末ID>` は `SELECT id, device_id, name, spot, date, slot FROM feedback ORDER BY updated_at DESC LIMIT 20` などで探す。

```bash
# ある端末の記録
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT photo_key FROM feedback WHERE device_id = '<端末ID>' AND photo_key IS NOT NULL"
npx wrangler@4 r2 object delete surf-check-photos/<photo_key> --remote   # 控えた写真ごとに
npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM feedback WHERE device_id = '<端末ID>'"

# 日付の範囲で消す（写真は同じ条件の SELECT photo_key で控えてから消す）
npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM feedback WHERE date BETWEEN '2026-10-01' AND '2026-10-07'"
```

消したあとは、[docs/r2-security.md](docs/r2-security.md) の「数のずれを直す」の2で写真の容量の合計を作り直す。やらないと、消した写真のぶんが上限の計算に残る。

### ポイント名を変えたとき

記録はポイントを名前で持っている。`spots.json` で名前を変えたら、記録側も書き換える。書き換えなくてもエラーにはならないが、そのポイントに補正がかからなくなる。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "UPDATE feedback SET spot = '<新しい名前>' WHERE spot = '<古い名前>'"
```

## スポット・採点ロジックの大元

このリポジトリは公開用。スポット定義(`spots.yaml`)と採点ロジック(Python版)の出所は
別プロジェクト `notion_tools` 側。スポットを更新する場合はそちらで `spots.json` を再生成し、
`spots.json`（および変更時は `scoring.js`）を本リポジトリへ反映する。

**注意:** `cams`（ライブカメラ）は `notion_tools` 側には無く、本リポジトリの `spots.json` にだけ持たせている。`spots.json` を再生成するときは `cams` を消さないこと。`spots.test.js` に「どのエリアにもカメラ付きのポイントが1つ以上ある」テストを置いてあるので、丸ごと落ちた場合はテストが落ちる。

## データソース

Open-Meteo の GFS-Wave 系の数値予報モデル。実測値ではない点に注意。
````

`docs/r2-security.md` を次の内容で作る。写真（R2）の料金が膨らまないための守りと、持ち主が手で行うことをまとめた文書。

````markdown
# 写真（R2）のコスト対策と緊急時の手順

実況フィードバックの写真を置く Cloudflare R2 について、どこでお金がかかるか、どう抑えているか、何かあったときに何をするかをまとめる。コマンドはすべて `worker/` で実行する。料金と無料枠は 2026年9月に Cloudflare のドキュメントで確かめた値。

## 構成

```
ブラウザ（GitHub Pages のサイト）
  │ POST /feedback（記録 + 写真1枚まで）      GET /calibration（補正）
  ▼                                           ▼
Cloudflare Worker（surf-check-feedback）
  ├─ D1（surf-check-feedback）：記録、送信の数、写真の容量の合計
  └─ R2（surf-check-photos）：写真。Worker が put と delete をするだけ
```

- R2 に書くのは Worker だけ。写真の名前（`photos/<ランダムな UUID>.jpg`）は Worker が作る。送る側が書いた名前やファイル名は使わない。
- 写真を外に出す口は無い。公開 URL（r2.dev）、自分のドメイン、署名付き URL、写真を返す API のどれも作っていない。写真を見るのは Cloudflare の管理画面だけ。
- Worker は R2 の一覧（List）を呼ばない。容量は D1 の `storage_usage` で数える。
- 送る人のログインは無い（誰でも送れる、という仕様）。そのぶん、回数・大きさ・容量の上限で抑える。

## お金がかかるところ

| 何に | 無料枠（1か月） | 超えた分 | この Worker が使う量 |
|---|---|---|---|
| R2 の保存容量 | 10GB | $0.015/GB | 写真の合計。`GLOBAL_STORAGE_LIMIT`（既定 5GB）で止める |
| R2 の Class A（put・list） | 100万回 | $4.50/100万回 | 写真を置くたびに1回。1日 `GLOBAL_DAILY_COUNT_LIMIT`（既定 100）回まで |
| R2 の Class B（get） | 1000万回 | $0.36/100万回 | Worker は読まない。管理画面で見たときだけ |
| R2 の delete・転送量 | 無料 | 無料 | 写真の差し替え・片付け |
| Workers のリクエスト | 無料プランは1日10万件 | 無料プランは超えるとエラー（請求なし）。有料プランは1000万件/月を超えた分が $0.30/100万件 | POST・GET とも1件ずつ |
| D1 の読み取り | 無料プランは1日500万行 | 無料プランは超えるとエラー。有料プランは250億行/月を超えた分が $0.001/100万行 | POST は1回数百行。GET /calibration は記録の全件 |
| D1 の書き込み | 無料プランは1日10万行 | 無料プランは超えるとエラー。有料プランは5000万行/月を超えた分が $1.00/100万行 | 受け付けた送信1件で数行 |

既定の上限のままなら、R2 は無料枠を超えない。put は多くても1日100回（1か月3,100回）で、容量は 5GB で止まる。Workers と D1 は、無料プランなら上限でエラーになるだけで請求は来ない。

## 守り

POST /feedback は次の順に確かめる。先の段で断れば、後の段（とくに R2）には進まない。

1. 設定：`IP_SALT` が無い、上限の変数が整数として読めないときは 500 を返し、何も保存しない。
2. 大きさ：`Content-Length` が `MAX_UPLOAD_SIZE` + 512KB を超えていれば読まずに 413。宣言が無くても、読みながら数えて超えた時点で読むのをやめて 413。
3. 中身：記録を検証する（400）。写真は `MAX_UPLOAD_SIZE` を超えれば 413、先頭が JPEG（`FF D8 FF`）でなければ 415。
4. 回数と容量：D1 の1回のトランザクションで、上限を確かめて、送信を記録し、写真の容量を足す。同時に何件来ても、上限を超えて通ることはない。回数の上限に当たれば 429。容量の上限に当たったとき、非常停止中のときは、写真を置かずに記録だけ受け付ける（下の「写真だけ置かない場合」）。
5. R2 に put する。失敗したら、置きかけた写真を消し、足した容量を戻して 500。
6. D1 に記録を保存する。失敗したら、置いた写真を消し、容量を戻して 500。
7. 後片付け：3日より前の送信の記録を消す。同じ組の送り直しで写真が差し替わったら、古い写真を消して容量を戻す。ここでの失敗はログに残すだけで、送信は成功のまま返す。

Worker は D1 と R2 への呼び出しをやり直さない（リトライ0回）。送り直すかどうかは送った人が決める。同じ端末・ポイント・日付・時間帯の記録は1件だけで、送り直すと上書きになる（写真も差し替え）。

写真を消せなかったときは、その写真の容量を数えたままにする（多めに数える側に倒す）。消せなかった写真の名前はログ（`photo_orphan`）に出るので、「数のずれを直す」の手順で片付ける。

### 上限と環境変数

上限は `worker/quota.mjs` の `DEFAULT_LIMITS` が既定値。変えるときは、同じ名前の変数を `wrangler.toml` の `[vars]` に文字列で書いて deploy する。空文字は既定値に戻る。整数として読めない値（`"10MB"`、`"1.5"`、`"-1"`、`"1e6"`）を入れると、Worker は 500 を返して何も保存しない。

| 変数 | 既定値 | 数えるもの | 超えたとき |
|---|---|---|---|
| `MAX_UPLOAD_SIZE` | 1572864（1.5MB） | 写真1枚の大きさ。10485760（10MB）より大きくはできない | 413 |
| `MINUTE_COUNT_LIMIT` | 5 | 1端末の、また1回線の、直近60秒の送信 | 429（`device_minute` / `ip_minute`） |
| `DAILY_UPLOAD_COUNT_LIMIT` | 20 | 1端末の1日（日本時間）の送信 | 429（`device`） |
| `IP_DAILY_COUNT_LIMIT` | 30 | 1回線の1日の送信 | 429（`ip`） |
| `GLOBAL_DAILY_COUNT_LIMIT` | 100 | 全員の1日の送信 | 429（`total`） |
| `DAILY_UPLOAD_LIMIT` | 10485760（10MB） | 1端末の1日の写真の合計 | 写真だけ置かない（`device_bytes`） |
| `GLOBAL_DAILY_UPLOAD_LIMIT` | 104857600（100MB） | 全員の1日の写真の合計 | 写真だけ置かない（`global_bytes`） |
| `USER_STORAGE_LIMIT` | 209715200（200MB） | 1端末が R2 に置いている写真の合計 | 写真だけ置かない（`device_storage`） |
| `GLOBAL_STORAGE_LIMIT` | 5368709120（5GB） | R2 に置いている写真の合計 | 写真だけ置かない（`global_storage`） |

ほかの変数：

| 変数 | 置き場所 | 中身 |
|---|---|---|
| `ALLOWED_ORIGINS` | `wrangler.toml` | POST を受け付けるサイトのオリジン（カンマ区切り）。ブラウザ以外からの送信は止められないので、守りは上の上限が受け持つ |
| `IP_SALT` | secret（`wrangler secret put`） | 回線ごとの数え方に使う IP のハッシュの塩。D1 には IP そのものは入らない |
| `R2_KILL_SWITCH` | `wrangler.toml` | `"false"` か `"0"` のときだけ写真を置く。それ以外（`"true"`、空、書き忘れ）は写真を置かない |

回数の上限は、429 を返した送信は数えない。1日の区切りは日本時間の0時。

### 写真だけ置かない場合

容量の上限か非常停止に当たったとき、Worker は記録を保存し、写真は置かずに 200 を返す。返事には理由が付く。

```json
{ "ok": true, "id": 12, "updated": false, "photo_skipped": "kill_switch" }
```

入力パネルは「送りました。写真は今は受け付けていないため、記録だけ保存しました」と出し、自動では閉じない。記録（予報と実況の組）は補正に使えるので、写真が無くても受け付ける方を選んだ。

## 管理画面での設定

コードでは決められないので、公開の前に手で確かめる。

1. **予算アラート（通知だけ）**：Manage Account → Billing → Billable Usage → Create budget alert で、$1・$5・$10 のように金額で作る。従量課金のアカウントだけで使える。届くのは1日ほど遅れることがあり、**超えても止まらない**。守りは上の上限と非常停止で、アラートは気づくためのもの。
2. **R2 のバケットを公開しない**：作ったばかりのバケットは非公開で、r2.dev の公開 URL も切れている。そのままにする。確かめるには次を実行し、r2.dev が無効で、ドメインが1つも無いことを見る。
   ```bash
   npx wrangler@4 r2 bucket dev-url get surf-check-photos
   npx wrangler@4 r2 bucket domain list surf-check-photos
   ```
3. **ライフサイクル**：作ったばかりのバケットには、途中で止まったマルチパートのアップロードを7日で消すルールが入っている。それだけにする。日数で写真を消すルールは足さない。R2 だけで消えると、D1 の記録と容量の合計がずれるため。写真を減らしたいときは「古い写真を減らす」の手順で消す。
   ```bash
   npx wrangler@4 r2 bucket lifecycle list surf-check-photos
   ```
4. **API トークン**：この構成では作らない。公開は `npx wrangler@4 login` のブラウザでのログインで行う。R2 の API トークン（R2 → Account Details → API Tokens → Manage）が1つも無いことを確かめる。あとで自動 deploy などにトークンが要るときは、このアカウントとこの Worker・D1 だけに絞り、期限を付ける。
5. **自分のドメイン**：付けない。Worker は `workers.dev` のまま、R2 には付けない。
6. **キャッシュ**：設定は要らない。写真を返す口が無いので、写真の配信のキャッシュは無い。`GET /calibration` はブラウザ向けに5分のキャッシュの指示を返す。Worker の中のキャッシュ（Cache API）は `workers.dev` では働かないので使っていない。
7. **WAF**：`workers.dev` のままでは使えない（WAF は自分のドメインに付けるもの）。有料プランに移すときに、Worker を自分のドメインにつなぎ、`/feedback` と `/calibration` にレート制限を付けることを考える（そのときの Cloudflare のドキュメントで確かめる）。

## 見張る

- **ログ**：`npx wrangler@4 tail` で今の送信をその場で見られる（無料）。Worker は1回の送信ごとに JSON を1行出す。端末 ID・名前・IP・IP のハッシュ・記録の中身は出さない。

  | event | 出るとき | 中身 |
  |---|---|---|
  | `feedback` | 送信ごと | `status`、`limit`（429 のとき）、`photo_skipped`、`photo_bytes`、`updated` |
  | `config_error` | 変数が無い・読めない | `variable`（変数の名前） |
  | `r2_error` | 写真を置けなかった | `error`（例外の名前と文、200文字まで） |
  | `d1_error` | 記録の保存か後片付けに失敗した | `error` |
  | `photo_orphan` | 写真を消せなかった | `key`（写真の名前）、`error` |
  | `error` | 想定外の例外 | `error` |

- **R2 の量**：管理画面の R2 → surf-check-photos → Metrics で、写真の数と合計の大きさが見られる（List を呼ばないので Class A を使わない）。D1 の数と比べる。
  ```bash
  npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT used_bytes, file_count FROM storage_usage WHERE scope = 'global'"
  ```
  R2 の方が多ければ、消せなかった写真（`photo_orphan`）があるか、Worker 以外が書いている（「トークンが漏れたとき」を見る）。
- **送信の様子**：直近4日の、日ごとの送信の数・写真の合計・写真を置かなかった数。
  ```bash
  npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT day, COUNT(*) AS sends, SUM(photo_bytes) AS photo_bytes, COUNT(photo_skipped) AS skipped FROM submissions GROUP BY day ORDER BY day"
  ```
- **Workers と D1**：管理画面の Workers & Pages → surf-check-feedback → Metrics でリクエストとエラーの数、D1 → surf-check-feedback → Metrics で読み書きの行数が見られる。

## 数のずれを直す

`storage_usage` がずれるのは、写真を消せなかったとき（多めに数える）と、記録や写真を手で消したとき。順番に直す。

1. ログの `photo_orphan` に出た写真の名前ごとに、記録から使われていないことを確かめてから消す。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT id FROM feedback WHERE photo_key = '<key>'"
   # 何も返らなければ消す
   npx wrangler@4 r2 object delete surf-check-photos/<key> --remote
   ```
2. 記録から合計を作り直す。1の前にやると、消せていない写真のぶんが数から抜けるので、必ず1の後に行う。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM storage_usage; INSERT INTO storage_usage (scope, used_bytes, file_count) SELECT 'global', COALESCE(SUM(photo_bytes), 0), COUNT(*) FROM feedback WHERE photo_key IS NOT NULL; INSERT INTO storage_usage (scope, used_bytes, file_count) SELECT 'device:' || device_id, SUM(photo_bytes), COUNT(*) FROM feedback WHERE photo_key IS NOT NULL GROUP BY device_id"
   ```
3. 「見張る」の R2 の Metrics と、`storage_usage` の `global` が合っていることを見る。

### 古い写真を減らす

日付を決めて、写真の名前を控え、R2 から消し、記録から外し、合計を作り直す。記録（予報と実況）は残るので補正には影響しない。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT photo_key FROM feedback WHERE photo_key IS NOT NULL AND date < '2027-01-01'"
npx wrangler@4 r2 object delete surf-check-photos/<photo_key> --remote   # 控えた写真ごとに
npx wrangler@4 d1 execute surf-check-feedback --remote --command "UPDATE feedback SET photo_key = NULL, photo_bytes = NULL, photo_lat = NULL, photo_lon = NULL, photo_taken_at = NULL WHERE photo_key IS NOT NULL AND date < '2027-01-01'"
```

そのあと「数のずれを直す」の2と3を行う。

## 緊急時の手順

### A. 写真だけ止める（非常停止）

記録は受け付けたまま、R2 への put を止める。

```bash
# wrangler.toml の R2_KILL_SWITCH = "false" を "true" に書き換えてから
npx wrangler@4 deploy
```

- 急ぐときは管理画面の Workers & Pages → surf-check-feedback → Settings → Variables and Secrets で `R2_KILL_SWITCH` を `true` にしてもよい（保存するとすぐ新しい版になる）。ただし、次に `wrangler deploy` すると `wrangler.toml` の値に戻るので、あとで `wrangler.toml` も同じにする。
- 止まったかは、`npx wrangler@4 tail` を開いたまま写真付きで1件送り、`"photo_skipped":"kill_switch"` が出ることで確かめる。
- 戻すときは `"false"` にして deploy する。

### B. 受け付けごと止める

`wrangler.toml` の `[vars]` に `GLOBAL_DAILY_COUNT_LIMIT = "0"` を書いて deploy する。すべての POST が 429（「今日はこれ以上送れません」）になり、R2 にも D1 の記録にも何も書かない。`GET /calibration` は動いたままなので、サイトの補正はそのまま出る。戻すときはその行を消して deploy する。

### C. Worker ごと止める

Worker そのものへのリクエストが多すぎるとき（有料プランで請求が増えている、D1 の読み取りの上限に当たっている）。`wrangler.toml` に `workers_dev = false` を書いて deploy すると、`workers.dev` の URL が答えなくなる。管理画面だけで止めると次の `wrangler deploy` で元に戻るので、`wrangler.toml` で止める。サイトは補正なし（Worker が無いときと同じ表示）で動き続け、「行ってきた」からの送信は「送れませんでした」になる。

### D. トークンが漏れたとき

Cloudflare のトークンやログインが漏れると、Worker を通らずに R2 に直接書ける。上の上限は効かない。

1. My Profile → API Tokens（自分のトークン）、Manage Account → API Tokens（アカウントのトークン）、R2 → Account Details → API Tokens → Manage（R2 のトークン）で、知らないトークン・使っていないトークンを消す（ロールする）。
2. `npx wrangler@4 logout` のあと `npx wrangler@4 login` でログインし直す。
3. R2 の Metrics で写真の数と大きさを見て、D1 の `storage_usage` より多ければ、管理画面のバケットの中身を見て知らない物を消す。
4. Workers & Pages → surf-check-feedback → Deployments で、自分の知らない deploy が無いか見る。あれば手元から `npx wrangler@4 deploy` し直す。
5. D1 の中身を持ち出されたおそれがあれば、`IP_SALT` を取り替える（`openssl rand -hex 32 | npx wrangler@4 secret put IP_SALT`）。取り替えたその日は、回線ごとの数え方が0からになる。

### 原因を調べる

- `npx wrangler@4 tail` で `feedback` の `status` と `limit`、`photo_skipped` を見る。429 の `total` が続くなら誰かが全体の上限を埋めている。`device_minute` が1台から続くならその端末の暴走。
- 「見張る」の送信の様子の SQL で、日ごとの数と写真の合計を見る。

## 被害はどこまで広がるか

既定の上限のままの場合。

**Worker の API が攻撃されたとき**
- R2：put は1日100回、写真の追加は1日100MB、合計は5GBで止まる。無料枠（100万回、10GB）の中なので R2 の請求は $0。
- 無料プランの Workers と D1：請求は来ない。全体の1日100件を埋められると、その日（日本時間0時まで）はほかの人が送れない。Workers の1日10万件か D1 の1日の読み取りを使い切られると、リセットまで補正も送信も止まる（Workers は UTC の0時、日本時間の9時にリセット）。サイトそのもの（GitHub Pages と Open-Meteo）は動き続け、補正なしの表示になる。
- 有料プランにした場合：リクエストと D1 の読み取りが、攻撃の量に比例して請求される。とくに `GET /calibration` は1回で記録の全件を読む（記録が1000件なら、100万回で10億行、約 $1）。有料プランに移すなら、先に「残るリスク」の1を片付けるか、C の手順をすぐ使えるようにしておく。

**バグで暴走したとき**
- 入力パネルが送信を繰り返すようなバグ：1端末は1分5件・1日20件、写真は1日10MBで止まる。全体でも上と同じ量で止まる。
- Worker のコードが上限を通らずに R2 に書くようなバグ：上限は効かない。テスト（`worker/worker.test.mjs`）で put の回数と容量の数を確かめて防いでいる。起きたら A で写真を止め、それでも止まらなければ C。

**トークンが漏れたとき**
- Worker の外なので、上限も非常停止も効かない。R2 の容量と操作の回数は、漏れたトークンの使われ方しだいで、上限が無い。
- 気づく手段は、予算アラート（1日ほど遅れる。止めはしない）と、R2 の Metrics と D1 の `storage_usage` の比べ合わせ。
- D の手順でトークンを消す。R2 の API トークンを作らないこと、トークンに期限と対象の絞り込みを付けることで、漏れる物を減らしておく。

予算アラートは守りではない。届いたときにはもう請求が発生していて、止まりもしない。

## 残るリスク

1. **`GET /calibration` が毎回全件を読む（中）**：無料プランでは上限に当たって止まるだけだが、有料プランでは読み取りが請求される。計算結果を D1 に保存して数分ごとにだけ計算し直す、という直し方がある。今は記録が少なく無料プランなので、手を付けていない。
2. **端末 ID は送る側が決める**：ID を変えれば、端末ごとの上限は避けられる。回線ごと・全体の上限で抑えている。
3. **回線を共有する人**：携帯の回線や同じ Wi-Fi の人は、回線ごとの上限（1分5件・1日30件）を一緒に使う。
4. **無料プランでの妨害**：上の「攻撃されたとき」のとおり、請求は来ないが、その日は送れなくなる。
5. **写真の中身**：確かめているのは JPEG の先頭と大きさだけ。EXIF はブラウザが消してから送るが、ブラウザを通さずに送られた写真には残っていることがある。写真は公開していない。
6. **手で消したときの数のずれ**：「数のずれを直す」で直す。

## この構成で使っていないもの

- 署名付き URL（presigned URL）：写真は Worker が受け取って put する。R2 に直接上げさせない。
- 写真の公開と配信のキャッシュ：写真を返す口が無い。
- 送る人のログイン：誰でも送れる仕様。上限で抑える。
- リトライ：Worker は D1 と R2 の呼び出しをやり直さない。
- 検証用の環境（staging）：ローカルの `wrangler dev`（ローカルの D1 と R2）とテストで確かめ、本番は1つだけ。
````

- [ ] **Step 2: 書いたことと実物が合っているかを確かめる**

```bash
for f in calibration.js feedback.js feedback-panel.js calibration.test.js feedback.test.js worker/index.mjs worker/handler.mjs worker/quota.mjs worker/schema.sql worker/wrangler.toml worker/d1-sqlite.mjs worker/worker.test.mjs docs/r2-security.md; do test -f "$f" || echo "missing $f"; done
grep -n 'surf-check-feedback\|surf-check-photos' worker/wrangler.toml
grep -c 'IP_SALT=' README.md
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { DEFAULT_LIMITS } from "./worker/quota.mjs";
const doc = readFileSync("docs/r2-security.md", "utf8");
const limits = Object.entries(DEFAULT_LIMITS).filter(([name, value]) => !doc.includes(`| \`${name}\` | ${value}`)).map(([name]) => name);
const events = [...readFileSync("worker/handler.mjs", "utf8").matchAll(/event: "(\w+)"/g)].map((m) => m[1]).filter((e) => !doc.includes(`\`${e}\``));
console.log(limits.length || events.length ? `not in docs: ${[...limits, ...events].join(", ")}` : "docs match the code");
'
node --test 2>&1 | grep -E '^ℹ (tests|fail)'
```

Expected:
- `missing` は1行も出ない。
- `wrangler.toml` に2つの名前が出る。
- `IP_SALT=` は README の中で1回だけ出てくる（`openssl rand` で作る例の行）。値そのものは書いていない。
- `docs match the code` が出る。
  - 文書の上限の表に `DEFAULT_LIMITS` の名前と既定値がすべてあり、`handler.mjs` のログの `event` がすべて文書に出てくる、という意味。
  - `not in docs: ...` が出たら、そこに並んだ名前の行を文書で直す。
- `ℹ tests 240`、`ℹ fail 0`

- [ ] **Step 3: コミットする**

```bash
git add README.md docs/r2-security.md
git commit -F - <<'EOF'
docs: describe session feedback, the worker and R2 cost upkeep

README に、実況フィードバックと補正の説明、構成の新しいファイル、Worker を
ローカルで動かす方法、公開の手順、記録の消し方とポイント名の書き換え方を
足した。docs/r2-security.md に、写真（R2）でお金がかかるところ、上限と
変え方、管理画面で手で設定すること、見張り方、数のずれの直し方、緊急時の
手順、被害の範囲と残るリスクをまとめた。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: `wrangler dev` でのローカル確認（ユーザーの承認が必要）

**Files:**
- 作るがコミットしない：`worker/.dev.vars`（`.gitignore` 済み）、`worker/.wrangler/`（ローカルの D1・R2。`.gitignore` 済み）

**Interfaces:**
- Consumes:
  - Task 4 の Worker 一式と `schema.sql`
  - Task 6 の `$VERIFY/photo.jpg`（`scenario-send.mjs` が作った、EXIF 付きの JPEG）
  - Task 5 の `$VERIFY/static.mjs`
- Produces: 本物の実行環境（workerd + ローカルの D1 / R2）で、Task 5・6 の確認用 Worker と同じ振る舞いになること、上限と写真の非常停止が効くことの確認。コードの変更は無い。

- [ ] **Step 1: ユーザーの承認を得る**

`npx wrangler@4` は、npm から wrangler を取ってきて実行する。初めて実行する前に、ユーザーに次のように尋ね、承認を待つ。

「ローカルで Worker を動かすために `npx wrangler@4`（Cloudflare 公式の開発ツール。npm から取得、package.json は作らない）を実行してよいですか」

承認が得られなければ、このタスクと Task 9 は行わない。そのときは tasks/todo.md の結果の記録に、次のように書いて終える。

「ローカル確認は Task 5・6 の確認用 Worker（node:sqlite）で行った。wrangler での確認は未実施」

- [ ] **Step 2: 開発用の設定を作る**

```bash
cd "$REPO/worker"
printf 'ALLOWED_ORIGINS=http://localhost:8000,http://localhost:8001\nIP_SALT=%s\n' "$(openssl rand -hex 16)" > .dev.vars
git -C "$REPO" check-ignore worker/.dev.vars
git -C "$REPO" status --short
```

Expected:
- `check-ignore` が `worker/.dev.vars` を表示する。
- `status` に `.dev.vars` が出ない。

`IP_SALT` の値は表示しない（`cat .dev.vars` はしない）。

- [ ] **Step 3: ローカルの D1 にテーブルを作り、Worker を立てる**

```bash
cd "$REPO/worker"
npx wrangler@4 d1 execute surf-check-feedback --local --file schema.sql
npx wrangler@4 dev --port 8787
```

`wrangler dev` はバックグラウンドで動かし続ける。

Expected: `Ready on http://localhost:8787` が出る。

`database_id` が無いことを理由に止まったときは、次のようにする。
1. `wrangler.toml` の `# database_id: filled in at deploy` の行を、一時的に `database_id = "local-dev"` に置き換えて、やり直す。
2. この変更はコミットしない。Task 9 で本物の ID に置き換える。
3. このタスクの終わりに `git diff worker/wrangler.toml` で元に戻っていることを確かめる。

- [ ] **Step 4: API を確かめる**

```bash
YDAY=$(TZ=Asia/Tokyo date -v-1d +%F)
DEV1=$(uuidgen | tr A-Z a-z)
REC1=$(printf '{"device_id":"%s","name":"","spot":"一宮","date":"%s","slot":"evening","bearing":100,"forecast":{"wave_height":0.9,"wind_dir":270,"wind_speed":3.2,"swell_dir":95,"swell_period":9.5},"observed":{"rating":4,"wave_band":5,"wind_side":"off","wind_strength":"strong"},"photo_meta":{"lat":35.34,"lon":140.39,"taken_at":"%sT17:30"}}' "$DEV1" "$YDAY" "$YDAY")
curl -s http://localhost:8787/calibration; echo
curl -s -X POST http://localhost:8787/feedback -H 'Origin: http://localhost:8001' -F "record=$REC1" -F "photo=@$VERIFY/photo.jpg;type=image/jpeg"; echo
curl -s 'http://localhost:8787/calibration?metrics=1'; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/feedback -H 'Origin: https://example.com' -F "record=$REC1"
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/feedback -H 'Origin: http://localhost:8001' -F "record=$REC1" -F "photo=@$REPO/apple-touch-icon.png;type=image/jpeg"
```

Expected（上から順に）:
1. `{"version":1,"n":0,"spots":{},"weights":{...},"weights_learned":false,"generated_at":"..."}`
2. `{"ok":true,"id":1,"updated":false}`
3. `"n":1` で、`"一宮":{"n":1,"wave_factor":...}` の `wave_factor` が 1 より大きい。
   - 予報 0.9m に対して、アタマ〜オーバー（帯5）と答えたため。
   - `metrics` が付いている。記録1件なので値は `null`。
4. `403`（許可していないオリジン）
5. `415`（PNG は JPEG ではない）

2 が `403` のときは、`.dev.vars` の `ALLOWED_ORIGINS` が `[vars]` より優先されていない（仕様からの変更点 (o)）。次のようにしてやり直す。
1. `wrangler dev` を止める。
2. `wrangler.toml` の `ALLOWED_ORIGINS = "https://tk0407.github.io"` を、一時的に `ALLOWED_ORIGINS = "https://tk0407.github.io,http://localhost:8000,http://localhost:8001"` にする。
3. Step 3 の `npx wrangler@4 dev --port 8787` から流し直す。
4. この変更はコミットしない。Step 9 の片付けで元に戻っていることを確かめる。

- [ ] **Step 5: D1 の行と R2 の写真を確かめる**

```bash
cd "$REPO/worker"
npx wrangler@4 d1 execute surf-check-feedback --local --command "SELECT spot, date, slot, rating, wave_band, photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback"
KEY=$(npx wrangler@4 d1 execute surf-check-feedback --local --json --command "SELECT photo_key FROM feedback" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].photo_key))')
npx wrangler@4 r2 object get "surf-check-photos/$KEY" --local --file "$VERIFY/r2.jpg"
cmp "$VERIFY/photo.jpg" "$VERIFY/r2.jpg" && echo same-bytes
```

Expected:
- 1行ある。`photo_lat` = 35.34、`photo_lon` = 140.39、`photo_taken_at` = `<昨日>T17:30`。
- `photo_key` は `photos/<UUID>.jpg` の形。
- `same-bytes` が出る。
  - Worker は受け取った写真をそのまま保存する。
  - EXIF を消すのはブラウザの縮小の段階で、これは Task 6 で確かめた。

- [ ] **Step 6: 記録が増えると補正が変わることを確かめる**

```bash
DEV2=$(uuidgen | tr A-Z a-z)
REC2=$(printf '%s' "$REC1" | sed "s/$DEV1/$DEV2/")
curl -s -X POST http://localhost:8787/feedback -H 'Origin: http://localhost:8001' -F "record=$REC2"; echo
curl -s 'http://localhost:8787/calibration?metrics=1'; echo
```

Expected:
- 2つ目の端末の記録が入り、`"一宮":{"n":2,...}` になる。
- `wave_factor` は Step 4 より大きい。
  - 2台の記録なので、「補正なし」側へ寄せる力が相対的に弱まるため。
- `metrics` の `wave_band_mae`・`wind_strength_hit`・`wind_side_hit` が数値になる。記録2件で leave-one-out が計算できるため。
  - `rating_concordance` は `null` のまま。2件とも総合が 4 で、比べられる組が無いため。

- [ ] **Step 7: 任意：パソコンのブラウザから送ってもらう**

作業ツリーのコピーを、`FEEDBACK_API` を書き換えて 8001 で配る。

```bash
rm -rf "$VERIFY/api" && mkdir -p "$VERIFY/api"
rsync -a --exclude .git "$REPO/" "$VERIFY/api/"
sed -i '' 's|^const FEEDBACK_API = "";|const FEEDBACK_API = "http://localhost:8787";|' "$VERIFY/api/app.js"
node "$VERIFY/static.mjs" "$VERIFY/api" 8001
```

`static.mjs` はバックグラウンドで動かす。

ユーザーに、次を頼む。
- `http://localhost:8001/` を開き、ランキングのカードから写真付きで1件送る。
- 送ったら知らせる。

知らせを受けたら Step 5 の SELECT を流し、行が増えていることを確かめる。

ユーザーが断ったら、この Step は飛ばす。

- [ ] **Step 8: 写真の非常停止と1分の上限を確かめる**

Step 3 で立てた `wrangler dev` を止め、設定を変えて立て直す。`--var` は `[vars]` より優先される。

```bash
cd "$REPO/worker"
npx wrangler@4 dev --port 8787 --var R2_KILL_SWITCH:true --var MINUTE_COUNT_LIMIT:1
```

`wrangler dev` はバックグラウンドで動かし続ける。ローカルの D1 と R2 は `worker/.wrangler/` に残っているので、Step 4〜7 の記録はそのまま。

Expected: `Ready on http://localhost:8787` が出る。

同じ回線から1分以内に送った記録があると、回線の1分の上限に当たる。61秒待ってから、新しい端末で送る。

```bash
sleep 61
DEV3=$(uuidgen | tr A-Z a-z)
REC3=$(printf '%s' "$REC1" | sed "s/$DEV1/$DEV3/")
curl -s -X POST http://localhost:8787/feedback -H 'Origin: http://localhost:8001' -F "record=$REC3" -F "photo=@$VERIFY/photo.jpg;type=image/jpeg"; echo
curl -s -X POST http://localhost:8787/feedback -H 'Origin: http://localhost:8001' -F "record=$REC3"; echo
npx wrangler@4 d1 execute surf-check-feedback --local --command "SELECT photo_key FROM feedback ORDER BY id DESC LIMIT 1"
npx wrangler@4 d1 execute surf-check-feedback --local --command "SELECT (SELECT file_count FROM storage_usage WHERE scope = 'global') AS counted, (SELECT COUNT(*) FROM feedback WHERE photo_key IS NOT NULL) AS stored"
```

Expected（上から順に）:
1. `{"ok":true,"id":<数>,"updated":false,"photo_skipped":"kill_switch"}`（`id` は、Step 7 で送らなければ 3。送った分だけ大きくなる）
2. `{"error":"短い間に送りすぎです。1分ほど待ってから送ってください","limit":"device_minute"}`
3. `photo_key` が `null`（写真は R2 に置かれていない）
4. `counted` と `stored` が同じ数（Step 7 で写真付きを送っていなければ 1、送っていれば 2）

- [ ] **Step 9: 片付ける**

`wrangler dev` と 8001 の `static.mjs` を止める（8000 には触らない）。

```bash
git -C "$REPO" status --short
git -C "$REPO" diff --stat
```

Expected: `?? snapshot.html` 以外に何も出ない。`wrangler.toml` の一時的な変更（`database_id`、`ALLOWED_ORIGINS`）も残っていない。残っていたら `git checkout worker/wrangler.toml` で戻す。

コミットは無い。結果を tasks/todo.md の結果の記録に書く。`IP_SALT` の値は書かない。

---

### Task 9: Cloudflare への公開（ユーザーの承認が必要）

**Files:**
- Modify: `worker/wrangler.toml`（`database_id`）、`app.js`（`FEEDBACK_API`）、`index.html`（`?v=`）
- 公開後の結果によっては：`README.md`

**Interfaces:**
- Consumes: Task 4 の Worker 一式、Task 7 の README の手順、Task 8 の確認結果
- Produces: 公開された Worker の URL と、それを入れた `FEEDBACK_API`

- [ ] **Step 1: ユーザーの準備と承認を確かめる**

ユーザーに、次の5つを頼む・尋ねる。
1. Cloudflare のアカウントを作る。R2 を有効にするとき、支払い方法の登録を求められることがある（無料枠の中なら請求はない）。
2. `cd worker && npx wrangler@4 login` を、ユーザー自身の端末で実行する（ブラウザでログインする）。
3. 予算アラートを $1・$5・$10 で作る。手順は `docs/r2-security.md` の「管理画面での設定」の1。アラートは知らせるだけで、超えても止まらない（従量課金のアカウントでだけ作れる。作れなければ、その旨を結果の記録に書く）。
4. R2 の API トークンが1つも無いことを確かめる（同じく「管理画面での設定」の4）。
5. D1・R2 を作り、Worker を公開してよいかの承認。

5つとも済むまで、次の Step には進まない。

- [ ] **Step 2: D1 と R2 を作り、テーブルを作る**

```bash
cd "$REPO/worker"
npx wrangler@4 d1 create surf-check-feedback
```

出力された `database_id` で、`wrangler.toml` の `# database_id: filled in at deploy` の行を置き換える。

```toml
database_id = "<出力された ID>"
```

`database_id` は秘密の値ではない。使うにはアカウントの認証が要る。

```bash
npx wrangler@4 r2 bucket create surf-check-photos
npx wrangler@4 r2 bucket dev-url get surf-check-photos
npx wrangler@4 r2 bucket domain list surf-check-photos
npx wrangler@4 r2 bucket lifecycle list surf-check-photos
npx wrangler@4 d1 execute surf-check-feedback --remote --file schema.sql
```

Expected:
- どれもエラーなく終わる。
- `dev-url get`：r2.dev の公開 URL は無効（disabled）。
- `domain list`：ドメインが1つも無い。
- `lifecycle list`：途中で止まったマルチパートのアップロードを7日で消す、既定のルールだけ。

公開 URL かドメインがあったら、ここで止めてユーザーに知らせる。バケットの公開設定を変えるのはユーザーの承認が要る。

- [ ] **Step 3: `IP_SALT` を入れる**

値は画面にもファイルにも出さず、そのままパイプで渡す。

```bash
openssl rand -hex 32 | npx wrangler@4 secret put IP_SALT
```

Expected: `Success! Uploaded secret IP_SALT`

- [ ] **Step 4: 公開して、動きを確かめる**

```bash
npx wrangler@4 deploy
```

表示された URL（`https://surf-check-feedback.<アカウント>.workers.dev`）を `API` とする。

```bash
API=https://surf-check-feedback.<アカウント>.workers.dev
curl -s "$API/calibration"; echo
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$API/feedback" -H 'Origin: https://tk0407.github.io' -H 'Access-Control-Request-Method: POST'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/feedback" -H 'Origin: https://example.com'
```

Expected:
1. `{"version":1,"n":0,"spots":{},...}`
2. `204`
3. `403`

`deploy` の出力の変数の一覧に、`R2_KILL_SWITCH: "false"` と `ALLOWED_ORIGINS: "https://tk0407.github.io"` があることも見る。

- [ ] **Step 5: サイトに URL を入れる**

`app.js` の行を置き換える。

置き換える前：
```js
const FEEDBACK_API = "";
```
置き換えた後：
```js
const FEEDBACK_API = "https://surf-check-feedback.<アカウント>.workers.dev";
```

`index.html` の `?v=` を、公開する日の日付（YYYYMMDD）に上げる。その日付が 20260925 以下なら 20260926 にする。

```bash
V=<新しい日付>
sed -i '' "s/?v=20260925/?v=$V/g" index.html
grep -c "?v=$V" index.html
node --test 2>&1 | grep -E '^ℹ (tests|fail)'
```

Expected:
- `grep -c` は `11`（アイコン3・CSS 1・スクリプト7。どれも1行に1つ）。
  - 数が違うときは、`grep -n '?v=' index.html` で上げ漏れがないかを見る。
- `ℹ tests 240`、`ℹ fail 0`

- [ ] **Step 6: コミットする**

```bash
git add worker/wrangler.toml app.js index.html
git commit -F - <<'EOF'
feat: point the site at the deployed feedback worker

公開した Worker の URL を FEEDBACK_API に入れ、D1 の database_id を
wrangler.toml に書いた。index.html の ?v= を上げた。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: 公開後の確認（GitHub Pages に出てから）**

この Step は、ブランチが main に入り、GitHub Pages に出たあとで行う。

1. ユーザーに、スマホで公開サイトを開き、ランキングのカードから写真付きで1件送ってもらう。
2. 次を流す。

```bash
cd "$REPO/worker"
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT spot, date, slot, photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback ORDER BY id DESC LIMIT 1"
npx wrangler@4 r2 object get "surf-check-photos/<photo_key>" --remote --file "$VERIFY/phone.jpg"
LC_ALL=C grep -c 'Exif' "$VERIFY/phone.jpg"
```

Expected:
- R2 の写真に EXIF は残っていない（`grep -c` が `0`）。
- `photo_lat` / `photo_lon` / `photo_taken_at`
  - 入っていれば、そのまま使える。
  - 空（`null`）なら、README の「実況フィードバックと補正」の写真の箇条に次の一文を足す。そして別のブランチで PR にする。
    - 「この端末（<機種・ブラウザ>）では、端末が位置情報を消すため撮影位置・撮影時刻は使えない」

3. 写真の容量の数が R2 と合っているかを確かめる。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT used_bytes, file_count FROM storage_usage WHERE scope = 'global'"
```

Expected: `file_count` と `used_bytes` が、管理画面の R2 → `surf-check-photos` → Metrics のオブジェクト数・容量と合う（Metrics は反映が遅れることがある）。合わなければ `docs/r2-security.md` の「数のずれを直す」に従う。

4. ユーザーに、`docs/r2-security.md` の「緊急時の手順」（A 写真だけ止める、B 受け付けごと止める、C Worker ごと止める、D トークンが漏れたとき）と「被害はどこまで広がるか」を読んでおいてもらう。

---

## 結果の記録

実装が終わったら、この下に次のことを書く。
- 各タスクの結果
  - テストの件数
  - ブラウザでの確認の PASS / FAIL
  - wrangler での確認の結果
- 途中で決めたこと
- R2 のコスト対策の最終報告。次の見出しで書く。
  1. 今の構成
  2. 見つけたリスク
  3. 実装した変更
  4. 変えたファイル
  5. 上限（変数・既定値・超えたとき）
  6. セキュリティの改善
  7. コストの守り
  8. 管理画面で手で設定すること（予算アラートを作れたか、トークンが無いことを確かめたか、を含む）
  9. 残るリスク
  10. 緊急時の手順
- 被害の範囲を、API が攻撃されたとき・バグで暴走したとき・トークンが漏れたときの3つに分けて書く。予算アラートは知らせるだけで、守りではないことも書く。

秘密の値（`IP_SALT`、認証情報）と、ユーザーの端末 ID・名前・IP は書かない。
